/* ═════════ Jeton Shopify — obtenu automatiquement, jamais stocké ═════════
 *
 * Le jeton renvoyé par Shopify (Client Credentials Grant) expire au bout de
 * 24h. Plutôt que de le coller à la main dans Netlify et devoir recommencer
 * chaque jour, ce fichier le redemande lui-même à Shopify à chaque fois que
 * c'est nécessaire, avec l'ID client et le secret (qui eux n'expirent
 * jamais). Un petit cache mémoire évite de le redemander à chaque visiteuse
 * quand plusieurs appels se suivent de près.
 *
 * Variables Netlify nécessaires (Site settings → Environment variables) :
 *   SHOPIFY_STORE         = neuct5-dz.myshopify.com
 *   SHOPIFY_CLIENT_ID     = l'ID client (Dev Dashboard → Identifiants)
 *   SHOPIFY_CLIENT_SECRET = le Secret (même écran, bouton œil pour le voir)
 *
 * Ne jamais mettre le résultat (le shpat_...) dans une variable Netlify :
 * il expirerait en 24h et casserait tout sans prévenir.
 */

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cache = { token: null, expiresAt: 0 };

async function getShopifyToken() {
  if (!STORE || !CLIENT_ID || !CLIENT_SECRET) return null;

  // Encore valable (avec 5 min de marge) : on réutilise, pas besoin de rappeler Shopify.
  if (cache.token && Date.now() < cache.expiresAt) return cache.token;

  try {
    const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.access_token) return null;

    cache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, (data.expires_in || 0) - 300) * 1000
    };
    return cache.token;
  } catch (e) {
    return null;
  }
}

module.exports = { getShopifyToken, STORE };
