/**
 * AI-begroting voor de administratie-app.
 *
 * De app roept deze functie aan met een omschrijving van het werk (en eventueel foto's/schetsen).
 * De functie haalt zelf de materialenlijst, de kengetallen en eerdere begrotingen uit Firestore,
 * vraagt Claude om een voorstel en geeft onderdelen terug in precies het formaat van de begrotingsstaat.
 *
 * De API-sleutel staat als geheim in Firebase (ANTHROPIC_API_KEY) en komt nooit in de app zelf.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MODEL = 'claude-sonnet-5-5';
const MAX_VOORBEELDEN = 12;      // eerdere begrotingen die als voorbeeld meegaan
const MAX_AFBEELDINGEN = 4;

/* ---------- hulpfuncties ---------- */
function getal(n) { const v = parseFloat(n); return isFinite(v) ? v : 0; }
function normaliseer(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Compacte weergave van een eerdere begroting, zodat Claude jouw manier van begroten leert. */
function compactProject(p) {
  const onderdelen = ((p.begroting && p.begroting.onderdelen) || []).filter(o =>
    (o.materiaalregels || []).length || (o.urenregels || []).length);
  if (!onderdelen.length) return null;
  return {
    project: p.omschrijving || p.id,
    onderdelen: onderdelen.map(o => ({
      naam: o.naam,
      afmetingen: o.afmetingen || undefined,
      materiaal: (o.materiaalregels || []).map(r => `${getal(r.aantal)} × ${r.omschrijving} à €${getal(r.prijs)}`),
      uren: (o.urenregels || []).map(r => `${r.omschrijving || 'uren'}: ${getal(r.urenVoorbereiding)}u werkplaats, ${getal(r.urenMontage)}u montage`),
    })),
  };
}

const TOOL = {
  name: 'begroting_voorstel',
  description: 'Lever het begrotingsvoorstel aan in de structuur van de begrotingsstaat.',
  input_schema: {
    type: 'object',
    properties: {
      onderdelen: {
        type: 'array',
        description: 'De onderdelen van het werk, zoals ze in de begrotingsstaat komen.',
        items: {
          type: 'object',
          properties: {
            naam: { type: 'string', description: 'Korte naam, bijv. "Wandkast woonkamer"' },
            afmetingen: { type: 'string', description: 'B × H × D in mm, of leeg' },
            materiaalregels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  omschrijving: { type: 'string', description: 'Bij voorkeur exact de naam uit de materialenlijst' },
                  aantal: { type: 'number', description: 'Aantal in de eenheid van het materiaal (incl. zaagverlies)' },
                  prijs: { type: 'number', description: 'Inkoopprijs per eenheid excl. btw' },
                  uitLijst: { type: 'boolean', description: 'true als het materiaal uit de materialenlijst komt' },
                },
                required: ['omschrijving', 'aantal', 'prijs', 'uitLijst'],
              },
            },
            urenregels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  omschrijving: { type: 'string', description: 'Bijv. "Tekenwerk en werkvoorbereiding", "Maken kast", "Plaatsen"' },
                  urenVoorbereiding: { type: 'number', description: 'Uren in de werkplaats (tekenen, zagen, maken, afwerken)' },
                  urenMontage: { type: 'number', description: 'Uren op locatie (transport, plaatsen, afmonteren)' },
                },
                required: ['omschrijving', 'urenVoorbereiding', 'urenMontage'],
              },
            },
          },
          required: ['naam', 'afmetingen', 'materiaalregels', 'urenregels'],
        },
      },
      aannames: { type: 'array', items: { type: 'string' }, description: 'Aannames die je hebt gedaan (kort)' },
      vragen: { type: 'array', items: { type: 'string' }, description: 'Wat de meubelmaker nog bij de klant moet navragen' },
    },
    required: ['onderdelen', 'aannames', 'vragen'],
  },
};

function bouwSysteemPrompt(instellingen, materialen, voorbeelden) {
  const lijst = materialen.length
    ? materialen.map(m => `- ${m.naam} | eenheid: ${m.eenheid || '-'} | inkoop €${getal(m.prijs).toFixed(2)}`).join('\n')
    : '(nog geen materialen ingevoerd)';
  return `Je bent de calculator van een Nederlandse meubelmakerij voor maatwerk interieurs en meubels (Module 1, Vlaardingen).
Je maakt een eerste begrotingsvoorstel dat de meubelmaker daarna zelf controleert.

## Hoe deze werkplaats begroot
- Het werk wordt opgedeeld in onderdelen (bijv. per kast, per wand, per ruimte).
- Per onderdeel: materiaalregels (aantal × inkoopprijs) en urenregels.
- Uren worden gesplitst in "voorbereiding" (werkplaats: tekenen, zagen, maken, afwerken) en "montage" (op locatie: transport, plaatsen, afmonteren).
- De app rekent zelf: uurtarief €${getal(instellingen.uurtarief)}, materiaalmarge ${getal(instellingen.materiaalmarge)}%, kantoorkosten ${getal(instellingen.kantoorkosten)}%, btw ${getal(instellingen.btw)}%. Geef dus alleen INKOOPprijzen en uren, geen marges.

## Regels
- Gebruik materialen uit de materialenlijst hieronder, met exact dezelfde naam en prijs, en zet uitLijst op true.
- Staat iets er niet in, schat dan een realistische Nederlandse inkoopprijs (excl. btw, 2026) en zet uitLijst op false.
- Reken plaatmateriaal in de eenheid van de lijst (meestal m² of plaat) en tel ±15% zaagverlies mee.
- Vergeet beslag (scharnieren, ladegeleiders, grepen), kantenband, lijm/bevestiging en afwerking (lak/olie) niet.
- Schat uren realistisch voor een ervaren meubelmaker. Volg de verhoudingen uit de eerdere begrotingen hieronder als die er zijn.
- Ontbreekt informatie, doe dan een redelijke aanname, zet die bij "aannames" en zet wat de klant moet beantwoorden bij "vragen".
- Schrijf in het Nederlands, kort en zakelijk.
${instellingen.aiInstructies ? `\n## Extra werkwijze van de meubelmaker (volg dit altijd)\n${instellingen.aiInstructies}\n` : ''}
## Materialenlijst
${lijst}

## Eerdere begrotingen van deze werkplaats (als referentie voor uren en materiaalgebruik)
${voorbeelden.length ? JSON.stringify(voorbeelden) : '(nog geen eerdere begrotingen)'}`;
}

/* ---------- de functie ---------- */
exports.begrotingMetAI = onCall(
  { region: 'europe-west1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    // Alleen ingelogde beheerders
    if (!request.auth) throw new HttpsError('unauthenticated', 'Log eerst in.');
    const wDoc = await db.collection('werknemers').doc(request.auth.uid).get();
    if (!wDoc.exists || wDoc.data().rol !== 'admin') {
      throw new HttpsError('permission-denied', 'Alleen beheerders kunnen de AI-begroting gebruiken.');
    }

    const data = request.data || {};
    const omschrijving = String(data.omschrijving || '').slice(0, 8000).trim();
    const afbeeldingen = Array.isArray(data.afbeeldingen) ? data.afbeeldingen.slice(0, MAX_AFBEELDINGEN) : [];
    if (!omschrijving && !afbeeldingen.length) {
      throw new HttpsError('invalid-argument', 'Geef een omschrijving van het werk of voeg een foto/schets toe.');
    }

    // Gegevens uit Firestore
    const [instSnap, matSnap, projSnap] = await Promise.all([
      db.collection('meta').doc('instellingen').get(),
      db.collection('materialen').get(),
      db.collection('projecten').get(),
    ]);
    const instellingen = instSnap.exists ? instSnap.data() : {};
    const materialen = matSnap.docs.map(d => d.data()).filter(m => m.naam);
    const voorbeelden = projSnap.docs
      .map(d => d.data())
      .filter(p => p.id !== data.projectId)
      .sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')))
      .map(compactProject)
      .filter(Boolean)
      .slice(0, MAX_VOORBEELDEN);

    // Bericht aan Claude
    const content = [];
    afbeeldingen.forEach(a => {
      if (a && a.data && /^image\/(jpeg|png|webp|gif)$/.test(a.mediaType)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
      }
    });
    content.push({
      type: 'text',
      text: `Maak een begrotingsvoorstel voor het volgende werk${data.projectNaam ? ` (project: ${data.projectNaam})` : ''}:\n\n${omschrijving || '(zie de bijgevoegde afbeelding(en))'}`,
    });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: bouwSysteemPrompt(instellingen, materialen, voorbeelden),
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      const tekst = await res.text();
      console.error('Claude API fout', res.status, tekst);
      throw new HttpsError('internal', `De AI-dienst gaf een fout (${res.status}). Probeer het zo nog eens.`);
    }
    const antwoord = await res.json();
    const blok = (antwoord.content || []).find(b => b.type === 'tool_use');
    if (!blok) throw new HttpsError('internal', 'De AI gaf geen bruikbaar voorstel terug.');
    const voorstel = blok.input || {};

    // Prijzen uit de materialenlijst zijn leidend: corrigeer als de AI een andere prijs noemt
    const lijstPerNaam = new Map(materialen.map(m => [normaliseer(m.naam), m]));
    const onderdelen = (voorstel.onderdelen || []).map(o => ({
      naam: String(o.naam || 'Onderdeel'),
      afmetingen: String(o.afmetingen || ''),
      materiaalregels: (o.materiaalregels || []).map(r => {
        const uitLijst = lijstPerNaam.get(normaliseer(r.omschrijving));
        return {
          omschrijving: uitLijst ? uitLijst.naam : String(r.omschrijving || ''),
          aantal: Math.round(getal(r.aantal) * 100) / 100,
          prijs: uitLijst ? getal(uitLijst.prijs) : Math.round(getal(r.prijs) * 100) / 100,
          uitLijst: !!uitLijst,
        };
      }),
      urenregels: (o.urenregels || []).map(r => ({
        omschrijving: String(r.omschrijving || ''),
        urenVoorbereiding: Math.round(getal(r.urenVoorbereiding) * 10) / 10,
        urenMontage: Math.round(getal(r.urenMontage) * 10) / 10,
      })),
    }));

    return {
      onderdelen,
      aannames: (voorstel.aannames || []).map(String),
      vragen: (voorstel.vragen || []).map(String),
      gebruik: antwoord.usage || null,
    };
  }
);
