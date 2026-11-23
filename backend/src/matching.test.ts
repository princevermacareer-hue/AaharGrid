import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchScore, type MatchListing, type MatchRecipient } from './matching.js';

const now = new Date('2026-01-01T10:00:00Z');
const listing: MatchListing = { category: 'Meals', dietary: 'Vegetarian', quantity: 10, latitude: 28.6, longitude: 77.2, pickup_from: now, pickup_until: '2026-01-01T12:00:00Z', status: 'available' };
const recipient: MatchRecipient = { status: 'approved', capacity: 10, categories: ['Meals'], dietary: ['Vegetarian'], latitude: 28.6, longitude: 77.2, service_radius: 20, available_from: now, available_until: '2026-01-01T12:00:00Z', pickup_ready: true };

test('scores suitable nearby recipients above more distant recipients', () => {
  assert.equal(matchScore(listing, recipient, now), 100);
  assert.ok(matchScore(listing, { ...recipient, latitude: 28.65 }, now)! < 100);
});
test('rejects expired, incompatible, incomplete and unavailable candidates', () => {
  assert.equal(matchScore(listing, recipient, new Date('2026-01-01T12:00:00Z')), null);
  assert.equal(matchScore(listing, { ...recipient, capacity: 9 }, now), null);
  assert.equal(matchScore(listing, { ...recipient, categories: [] }, now), null);
  assert.equal(matchScore(listing, { ...recipient, available_until: null }, now), null);
  assert.equal(matchScore(listing, { ...recipient, latitude: 29 }, now), null);
  assert.equal(matchScore({ ...listing, status: 'reserved' }, recipient, now), null);
});
