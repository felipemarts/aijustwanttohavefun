/**
 * Prints a new VAPID key pair for Web Push: `pnpm --filter @ajwf/server vapid`.
 * Put both lines in `.env` (keep the private key secret; changing the keys invalidates every browser subscription).
 */
import { generateVAPIDKeys } from 'web-push';

const keys = generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
