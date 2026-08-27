/* ═════════ Roue de la fortune — tirage + code Shopify réel ═════════
 *
 * Pourquoi le tirage se fait ICI et pas dans le navigateur :
 * un 50/50 décidé en JS côté client est trivialement trichable (n'importe qui
 * peut ouvrir la console et forcer "gagné"). Le tirage doit être fait côté
 * serveur, sur une source aléatoire que la visiteuse ne contrôle pas.
 *
 * Pourquoi le code est un VRAI code Shopify à usage unique :
 * un minuteur de 30 minutes n'a de sens que si le code cesse réellement de
 * fonctionner à l'échéance. Un code inventé côté front, ou un code partagé
 * par tout le monde, rendrait le minuteur mensonger — exactement le problème
 * qu'on a évité avec la jauge de commandes.
 *
 * Le jeton Admin est redemandé automatiquement à chaque fois via
 * lib/shopify-token.js (voir ce fichier pour les 3 variables Netlify à
 * déclarer, notamment le scope write_discounts). Rien à renouveler à la main.
 *
 * Comportement si le scope n'est pas encore actif, ou si Shopify est
 * indisponible : la fonction répond win:false plutôt que d'inventer un code
 * qui ne fonctionnerait pas à la caisse.
 */

const { getShopifyToken, STORE } = require('./lib/shopify-token');
const API_VERSION = '2025-07';

const WIN_CHANCE = 0.5;           // une chance sur deux, réellement — pas un affichage
const DISCOUNT_PERCENT = 0.05;    // -5 %
const VALID_MINUTES = 30;

/* Anti-abus minimal : une même adresse IP ne peut relancer la roue qu'une
   fois toutes les VALID_MINUTES. C'est un frein de bon sens (éviter qu'un
   script tourne la roue en boucle), pas une protection anti-fraude
   complète — la mémoire d'une fonction Netlify ne survit pas entre tous
   les appels, donc ce n'est qu'une limite best-effort. */
const seen = new Map();
function tooSoon(ip) {
  const last = seen.get(ip);
  const now = Date.now();
  if (last && now - last < VALID_MINUTES * 60 * 1000) return true;
  seen.set(ip, now);
  return false;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I, ambigus à recopier
  let s = 'ROUE-';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function shopifyGraphQL(token, query, variables) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

const CREATE_DISCOUNT = `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) { nodes { code } }
            endsAt
          }
        }
      }
      userErrors { field code message }
    }
  }
`;

async function createRealDiscount(token, email) {
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + VALID_MINUTES * 60 * 1000);

  // Deux essais : si le code tiré au hasard existe déjà (collision rare),
  // on retente une fois avec un nouveau code plutôt que d'échouer.
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = randomCode();
    const { ok, data } = await shopifyGraphQL(token, CREATE_DISCOUNT, {
      basicCodeDiscount: {
        title: `Roue Pils. — ${email ? email.slice(0, 3) + '***' : 'anonyme'} — ${code}`,
        code,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: DISCOUNT_PERCENT },
          items: { all: true }
        }
      }
    });

    if (!ok || data.errors) continue;
    const errs = data?.data?.discountCodeBasicCreate?.userErrors || [];
    if (errs.length) continue;

    const node = data?.data?.discountCodeBasicCreate?.codeDiscountNode;
    const createdCode = node?.codeDiscount?.codes?.nodes?.[0]?.code;
    const createdEnds = node?.codeDiscount?.endsAt;
    if (createdCode) return { code: createdCode, expiresAt: createdEnds };
  }
  return null;
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let email = '';
  try {
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim();
  } catch (e) { /* corps invalide → traité comme sans email */ }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_email' }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';
  if (tooSoon(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'too_soon' }) };
  }

  // Le sort est tiré ICI, une seule fois, avant même de savoir si Shopify
  // répondra correctement — jamais recalculé après coup.
  const hasWon = Math.random() < WIN_CHANCE;

  if (!hasWon) {
    return { statusCode: 200, headers, body: JSON.stringify({ win: false }) };
  }

  const token = await getShopifyToken();
  if (!STORE || !token) {
    return { statusCode: 200, headers, body: JSON.stringify({ win: false, reason: 'not_configured' }) };
  }

  const discount = await createRealDiscount(token, email);
  if (!discount) {
    // Le tirage a désigné une gagnante mais Shopify n'a pas pu créer le
    // code (scope manquant, panne...). On ne ment pas en annonçant un code
    // qui ne fonctionnerait pas à la caisse.
    return { statusCode: 200, headers, body: JSON.stringify({ win: false, reason: 'discount_unavailable' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ win: true, ...discount }) };
};
