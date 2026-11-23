export interface MatchListing {
  category: string; dietary: string; quantity: number; latitude: number; longitude: number;
  pickup_from: Date | string; pickup_until: Date | string; status: string;
}
export interface MatchRecipient {
  status: string; capacity: number; categories: string[]; dietary: string[];
  latitude: number | null; longitude: number | null; service_radius: number;
  available_from: Date | string | null; available_until: Date | string | null; pickup_ready: boolean;
}

export function matchScore(l: MatchListing, r: MatchRecipient, now = new Date()): number | null {
  const start = Math.max(new Date(l.pickup_from).getTime(), r.available_from ? new Date(r.available_from).getTime() : Infinity, now.getTime());
  const end = Math.min(new Date(l.pickup_until).getTime(), r.available_until ? new Date(r.available_until).getTime() : -Infinity);
  if (l.status !== 'available' || r.status !== 'approved' || !r.pickup_ready ||
      r.latitude == null || r.longitude == null || r.capacity < l.quantity ||
      !r.categories.includes(l.category) || !r.dietary.includes(l.dietary) || start >= end) return null;
  const rad = Math.PI / 180;
  const lat = (r.latitude - l.latitude) * rad;
  const lon = (r.longitude - l.longitude) * rad;
  const a = Math.sin(lat / 2) ** 2 + Math.cos(l.latitude * rad) * Math.cos(r.latitude * rad) * Math.sin(lon / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  const distance = 6371 * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
  if (r.service_radius <= 0 || distance > r.service_radius) return null;
  const d = 100 * (1 - distance / r.service_radius);
  const q = 100 * l.quantity / r.capacity;
  const t = 100 * (end - start) / (new Date(l.pickup_until).getTime() - new Date(l.pickup_from).getTime());
  return Math.round(0.30 * d + 0.25 * q + 0.20 * t + 0.15 * 100 + 0.10 * 100);
}
