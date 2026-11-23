import { Component, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

type Role = 'donor' | 'recipient' | 'volunteer' | 'admin';
interface Profile {
  id: number; name: string; role: Role; status: string; organization: string; address: string;
  latitude: number | null; longitude: number | null; service_radius: number; capacity: number;
  categories: string[]; dietary: string[]; available_from: string | null; available_until: string | null; pickup_ready: boolean;
}
interface Listing {
  id: number; title: string; category: string; dietary: string; quantity: number; remaining?: number; unit: string;
  pickup_until: string; storage: string; packaging: string; status: string; score?: number;
  prepared_at: string; pickup_from: string; address?: string; latitude: number; longitude: number;
}
interface DonationRequest {
  id: number; title: string; unit: string; quantity: number; status: string; recipient: string; pickup_until: string;
}
interface Assignment {
  id: number; title: string; address: string; pickup_until: string; quantity: number; unit: string; status: string; volunteer: string;
}
interface Notification { id: number; message: string; read_at: string | null; created_at: string; }
interface UserReview { id: number; name: string; role: string; organization: string; status: string; }
interface Audit { id: number; actor: string; action: string; entity: string; entity_id: number; created_at: string; }
interface Overview { requests: number; pending: number; completed: number; }
type Config = { demo: true } | { demo: false; clientId: string; domain: string };
interface Match { id: number; name: string; organization: string; score: number; }

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly change = inject(ChangeDetectorRef);
  config: Config | null = null;
  profile: Profile | null = null;
  token = sessionStorage.getItem('access_token') || '';
  demoRole: Role = 'donor';
  loading = true;
  busy = false;
  error = '';
  message = '';
  tab = 'overview';
  overview: Overview | null = null;
  listings: Listing[] = [];
  requests: DonationRequest[] = [];
  assignments: Assignment[] = [];
  volunteers: { id: number; name: string }[] = [];
  notifications: Notification[] = [];
  users: UserReview[] = [];
  audit: Audit[] = [];
  matches: Match[] = [];
  matchesFor: number | null = null;
  requestQuantities: Record<number, number> = {};
  volunteerChoices: Record<number, number> = {};
  receiptQuantities: Record<number, number> = {};
  editingId: number | null = null;
  registration = { name: '', role: 'donor', organization: '', address: '' };
  preferenceCategories = '';
  preferenceDietary = '';
  availableFrom = '';
  availableUntil = '';
  listing = {
    title: '', category: 'Meals', dietary: 'Vegetarian', quantity: 1, unit: 'kg',
    prepared_at: '', pickup_from: '', pickup_until: '', address: '',
    latitude: null as number | null, longitude: null as number | null, storage: '', packaging: '', safety_declaration: false
  };
  readonly categories = ['Meals', 'Produce', 'Bakery', 'Dairy', 'Packaged food', 'Other'];
  readonly diets = ['Vegetarian', 'Vegan', 'Non-vegetarian', 'Other'];

  constructor() { void this.initialize(); }
  private async initialize() {
    try {
      this.config = await this.api<Config>('/api/config', undefined, false);
      if (this.config.demo) {
        this.clearSession();
        this.token = 'demo';
        await this.refresh();
        return;
      }
      const params = new URLSearchParams(location.search);
      if (params.has('error')) throw new Error(`Sign-in failed: ${params.get('error_description') || params.get('error')}`);
      if (params.has('code')) {
        const state = sessionStorage.getItem('oauth_state');
        const verifier = sessionStorage.getItem('oauth_verifier');
        if (!state || !verifier || params.get('state') !== state) throw new Error('Invalid sign-in state. Please try again.');
        history.replaceState(null, '', location.pathname);
        sessionStorage.removeItem('oauth_state'); sessionStorage.removeItem('oauth_verifier');
        const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, code: params.get('code')!, redirect_uri: location.origin + '/', code_verifier: verifier });
        const response = await fetch(`${this.config.domain}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!response.ok) throw new Error('Could not complete sign-in.');
        const tokens: { access_token: string; expires_in: number } = await response.json();
        this.token = tokens.access_token;
        sessionStorage.setItem('access_token', this.token);
        sessionStorage.setItem('expires_at', String(Date.now() + tokens.expires_in * 1000));
      }
      if (this.token && Number(sessionStorage.getItem('expires_at')) <= Date.now()) this.clearSession();
      if (this.token) await this.refresh();
    } catch (e) { this.error = this.errorText(e); }
    finally { this.loading = false; this.change.markForCheck(); }
  }
  async login() {
    try {
      if (!this.config || this.config.demo) throw new Error('Authentication is not configured.');
      const random = (length: number) => {
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      const verifier = random(48), state = random(32);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      sessionStorage.setItem('oauth_state', state); sessionStorage.setItem('oauth_verifier', verifier);
      const params = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: location.origin + '/', scope: 'openid', state, code_challenge_method: 'S256', code_challenge: challenge });
      location.assign(`${this.config.domain}/oauth2/authorize?${params}`);
    } catch (e) { this.error = this.errorText(e); this.change.markForCheck(); }
  }
  logout() {
    this.clearSession();
    if (this.config && !this.config.demo) {
      const params = new URLSearchParams({ client_id: this.config.clientId, logout_uri: location.origin + '/' });
      location.assign(`${this.config.domain}/logout?${params}`);
    }
  }
  private clearSession() {
    sessionStorage.removeItem('access_token'); sessionStorage.removeItem('expires_at');
    sessionStorage.removeItem('oauth_state'); sessionStorage.removeItem('oauth_verifier');
    this.token = ''; this.profile = null;
  }
  private errorText(e: unknown): string { return e instanceof Error ? e.message : 'Something went wrong.'; }
  private async api<T>(url: string, options?: RequestInit, auth = true): Promise<T> {
    const response = await fetch(url, { ...options, headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${this.token}` } : {}), ...(auth && this.config?.demo ? { 'X-Demo-Role': this.demoRole } : {}), ...options?.headers } });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`The API is unavailable or returned an unexpected response (HTTP ${response.status}).`);
    const data = await response.json();
    if (!response.ok) throw new Error([data.error || 'Request failed', ...(data.details || [])].join(': '));
    return data as T;
  }
  private send(url: string, method: string, body: unknown) {
    return this.api(url, { method, body: JSON.stringify(body) });
  }
  async action(work: () => Promise<unknown>, message: string) {
    this.busy = true; this.error = ''; this.message = '';
    try { await work(); await this.refresh(); this.message = message; }
    catch (e) { this.error = this.errorText(e); }
    finally { this.busy = false; this.change.markForCheck(); }
  }
  async refresh() {
    this.profile = await this.api<Profile | null>('/api/me');
    if (!this.profile) return;
    this.preferenceCategories = this.profile.categories.join(', ');
    this.preferenceDietary = this.profile.dietary.join(', ');
    this.availableFrom = this.localDate(this.profile.available_from);
    this.availableUntil = this.localDate(this.profile.available_until);
    this.notifications = await this.api<Notification[]>('/api/notifications');
    if (this.profile.status !== 'approved') return;
    const role = this.profile.role;
    this.overview = await this.api<Overview>('/api/analytics/overview');
    if (role !== 'volunteer') {
      [this.listings, this.requests] = await Promise.all([this.api<Listing[]>('/api/listings'), this.api<DonationRequest[]>('/api/requests')]);
    }
    if (role === 'recipient' || role === 'admin' || role === 'volunteer') this.assignments = await this.api<Assignment[]>('/api/assignments');
    if (role === 'recipient' || role === 'admin') this.volunteers = await this.api<{id:number;name:string}[]>('/api/volunteers');
    if (role === 'admin') [this.users, this.audit] = await Promise.all([this.api<UserReview[]>('/api/admin/users'), this.api<Audit[]>('/api/admin/audit-logs')]);
  }
  async switchDemoRole(role: Role) {
    this.demoRole = role;
    this.profile = null; this.overview = null; this.listings = []; this.requests = []; this.assignments = [];
    this.volunteers = []; this.notifications = []; this.users = []; this.audit = []; this.matches = [];
    this.matchesFor = null; this.tab = 'overview'; this.error = ''; this.message = '';
    try { await this.refresh(); }
    catch (e) { this.error = this.errorText(e); }
    finally { this.change.markForCheck(); }
  }
  private localDate(date: string | null): string {
    if (!date) return '';
    const d = new Date(date);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  private iso(date: string): string | null { return date ? new Date(date).toISOString() : null; }
  register() { return this.action(() => this.send('/api/me', 'POST', this.registration), 'Profile submitted for review.'); }
  saveProfile() {
    if (!this.profile) return;
    const data = { ...this.profile, categories: this.preferenceCategories.split(',').map(x => x.trim()).filter(Boolean), dietary: this.preferenceDietary.split(',').map(x => x.trim()).filter(Boolean), available_from: this.iso(this.availableFrom), available_until: this.iso(this.availableUntil) };
    return this.action(() => this.send('/api/me', 'PATCH', data), 'Profile saved.');
  }
  createListing() {
    const l = { ...this.listing, prepared_at: this.iso(this.listing.prepared_at), pickup_from: this.iso(this.listing.pickup_from), pickup_until: this.iso(this.listing.pickup_until) };
    const editingId = this.editingId;
    return this.action(async () => {
      await this.send(editingId ? `/api/listings/${editingId}` : '/api/listings', editingId ? 'PATCH' : 'POST', l);
      this.cancelEdit();
    }, editingId ? 'Listing updated; pending requests were rejected.' : 'Listing published.');
  }
  editListing(l: Listing) {
    this.editingId = l.id;
    this.listing = {
      title: l.title, category: l.category, dietary: l.dietary, quantity: l.quantity, unit: l.unit,
      prepared_at: this.localDate(l.prepared_at), pickup_from: this.localDate(l.pickup_from),
      pickup_until: this.localDate(l.pickup_until), address: l.address || '',
      latitude: l.latitude, longitude: l.longitude, storage: l.storage, packaging: l.packaging, safety_declaration: false
    };
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  cancelEdit() {
    this.editingId = null;
    this.listing = { title: '', category: 'Meals', dietary: 'Vegetarian', quantity: 1, unit: 'kg', prepared_at: '', pickup_from: '', pickup_until: '', address: '', latitude: null, longitude: null, storage: '', packaging: '', safety_declaration: false };
  }
  closeListing(id: number) { return this.action(() => this.send(`/api/listings/${id}/close`, 'PATCH', {}), 'Listing closed.'); }
  async showMatches(id: number) {
    this.error = '';
    try { this.matches = await this.api<Match[]>(`/api/listings/${id}/matches`); this.matchesFor = id; }
    catch (e) { this.error = this.errorText(e); }
    finally { this.change.markForCheck(); }
  }
  requestListing(id: number) { return this.action(() => this.send(`/api/listings/${id}/requests`, 'POST', { quantity: this.requestQuantities[id] }), 'Request submitted.'); }
  decide(id: number, decision: string) { return this.action(() => this.send(`/api/requests/${id}/decision`, 'PATCH', { decision }), 'Decision saved.'); }
  assign(id: number) { return this.action(() => this.send('/api/assignments', 'POST', { request_id: id, volunteer_id: Number(this.volunteerChoices[id]) }), 'Volunteer assigned.'); }
  transition(id: number, status: string) { return this.action(() => this.send(`/api/assignments/${id}/status`, 'PATCH', { status }), 'Pickup updated.'); }
  receipt(id: number) { return this.action(() => this.send(`/api/requests/${id}/receipt`, 'POST', { quantity: this.receiptQuantities[id] }), 'Receipt confirmed.'); }
  review(id: number, status: string) { return this.action(() => this.send(`/api/admin/users/${id}`, 'PATCH', { status }), 'Review saved.'); }
  readNotification(id: number) { return this.action(() => this.send(`/api/notifications/${id}/read`, 'PATCH', {}), 'Notification marked as read.'); }
}
