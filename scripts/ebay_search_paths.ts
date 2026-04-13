/**
 * Search eBay US category tree for paths containing specific keywords.
 * Used to discover the real leaf names so we can write tight aliases.
 */
import "dotenv/config";

const APP_ID = process.env.EBAY_APP_ID!;
const CERT_ID = process.env.EBAY_CERT_ID!;

const QUERIES = [
  "Collectible Card Games",
  "Non-Sport Trading Cards",
  "Sports Trading Cards",
  "Smartphones",
  "Pop Culture",
  "Wristwatches",
];

async function token(): Promise<string> {
  const b = Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${b}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

interface Node { category: { categoryId: string; categoryName: string }; childCategoryTreeNodes?: Node[] }

function flatten(n: Node, pathLabels: string[], out: Array<{ id: string; path: string }>): void {
  const path = [...pathLabels, n.category.categoryName];
  if (path.length > 1) out.push({ id: n.category.categoryId, path: path.slice(1).join(" > ") });
  for (const c of n.childCategoryTreeNodes ?? []) flatten(c, path, out);
}

async function main(): Promise<void> {
  const t = await token();
  const tree = await (await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0",
    { headers: { Authorization: `Bearer ${t}` } })).json() as { rootCategoryNode: Node };
  const flat: Array<{ id: string; path: string }> = [];
  flatten(tree.rootCategoryNode, [], flat);
  console.log(`${flat.length} categories total\n`);

  for (const q of QUERIES) {
    const hits = flat.filter((c) => c.path.toLowerCase().includes(q.toLowerCase()));
    if (hits.length === 0) {
      console.log(`── ${q} → (none)`);
      continue;
    }
    // Pick deepest first
    hits.sort((a, b) => b.path.split(" > ").length - a.path.split(" > ").length);
    console.log(`── ${q}`);
    for (const h of hits.slice(0, 4)) console.log(`   ${h.id.padStart(7)}  ${h.path}`);
  }
}

main();
