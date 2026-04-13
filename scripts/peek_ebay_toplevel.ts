/**
 * One-shot: list eBay US top-level categories so we can map them to our
 * roots properly. Prints id, name, and slug.
 */
import "dotenv/config";

const APP_ID = process.env.EBAY_APP_ID!;
const CERT_ID = process.env.EBAY_CERT_ID!;

async function token(): Promise<string> {
  const b = Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${b}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

async function main(): Promise<void> {
  const t = await token();
  const tree = await (await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0",
    { headers: { Authorization: `Bearer ${t}` } })).json() as {
    rootCategoryNode: { childCategoryTreeNodes?: Array<{ category: { categoryId: string; categoryName: string }, childCategoryTreeNodes?: Array<{ category: { categoryId: string; categoryName: string } }> }> }
  };
  const top = tree.rootCategoryNode.childCategoryTreeNodes ?? [];
  console.log(`${top.length} top-level eBay categories:\n`);
  for (const c of top.sort((a,b) => a.category.categoryName.localeCompare(b.category.categoryName))) {
    console.log(`  ${c.category.categoryId.padStart(6)}  ${c.category.categoryName}`);
  }
}
main();
