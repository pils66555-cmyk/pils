/* ═════════ Compteur de commandes — proxy Shopify Admin ═════════
 *
 * Pourquoi cette fonction existe :
 * le nombre de commandes n'est lisible que via l'Admin API de Shopify, qui
 * demande un jeton privé. Ce jeton ne doit JAMAIS se retrouver dans le HTML :
 * il donne accès aux commandes, aux clientes et au chiffre d'affaires. La
 * fonction s'exécute donc côté serveur Netlify et ne renvoie au navigateur
 * qu'un seul nombre.
 *
 * Le jeton lui-même est redemandé automatiquement à chaque fois via
 * lib/shopify-token.js (voir ce fichier pour les 3 variables Netlify à
 * déclarer). Rien à renouveler à la main.
 */

const { getShopifyToken, STORE } = require('./lib/shopify-token');
const API_VERSION = '2025-07';

/* Cache mémoire : l'instance de fonction est réutilisée entre deux appels
   rapprochés, ce qui évite de taper l'API Shopify à chaque visiteuse.
   Shopify limite le nombre d'appels ; 60 s de cache suffit largement pour une
   jauge, et le compteur reste honnête (au pire une minute de retard). */
let cache = { value: null, at: 0 };
const CACHE_MS = 60 * 1000;

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': '*'
  };

  if (cache.value !== null && Date.now() - cache.at < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({ count: cache.value, cached: true }) };
  }

  const token = await getShopifyToken();
  if (!STORE || !token) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ count: null, reason: 'not_configured' })
    };
  }

  try {
    /* `status=any` compte aussi les commandes annulées/remboursées.
       On reste sur les commandes réellement passées : c'est ce que la jauge
       annonce (« places prises »), pas le chiffre d'affaires net. */
    const url = `https://${STORE}/admin/api/${API_VERSION}/orders/count.json?status=any`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ count: null, reason: 'shopify_' + res.status })
      };
    }

    const data = await res.json();
    const count = typeof data.count === 'number' ? data.count : null;

    if (count !== null) cache = { value: count, at: Date.now() };

    return { statusCode: 200, headers, body: JSON.stringify({ count }) };
  } catch (e) {
    /* Toute panne renvoie count:null : la page garde sa valeur de repli
       plutôt que d'afficher une jauge fausse ou vide. */
    return { statusCode: 200, headers, body: JSON.stringify({ count: null, reason: 'error' }) };
  }
};
