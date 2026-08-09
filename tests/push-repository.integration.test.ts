import assert from "node:assert/strict";
import test from "node:test";
import { neonPushRepository } from "../lib/push-repository";

test("Neon registers, deduplicates, and deletes push subscriptions", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const pushKeyHash = `integration-${suffix}`;
  const eventId = `$integration-${suffix}:example.invalid`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await neonPushRepository.upsertSubscription(pushKeyHash, {
      endpoint: `https://push.example.invalid/${suffix}`,
      p256dh: "integration-p256dh",
      auth: "integration-auth",
    }, now);

    assert.deepEqual(await neonPushRepository.getSubscription(pushKeyHash), {
      endpoint: `https://push.example.invalid/${suffix}`,
      p256dh: "integration-p256dh",
      auth: "integration-auth",
    });

    assert.equal(await neonPushRepository.consumeRateLimit(pushKeyHash, now, 60, 120), true);

    const claims = await Promise.all([
      neonPushRepository.claimDelivery(pushKeyHash, eventId, now, 120),
      neonPushRepository.claimDelivery(pushKeyHash, eventId, now, 120),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
  } finally {
    await neonPushRepository.deleteSubscription(pushKeyHash);
  }

  assert.equal(await neonPushRepository.getSubscription(pushKeyHash), null);
});
