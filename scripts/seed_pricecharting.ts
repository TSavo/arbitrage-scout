// seed_from_pricecharting needs an invocation
import { seedFromPriceCharting } from "@/db/seed_from_pricecharting";
seedFromPriceCharting().then(r => { console.log(JSON.stringify(r)); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
