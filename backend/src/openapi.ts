const idParameter = {
  name: 'id', in: 'path', required: true, description: 'Numeric resource ID',
  schema: { type: 'integer', minimum: 1 }
};
const text = { type: 'string', minLength: 1, maxLength: 300 };
const timestamp = { type: 'string', format: 'date-time', example: '2030-01-01T10:00:00Z' };
const quantity = { type: 'number', exclusiveMinimum: true, minimum: 0 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const listing = object({
  title: text, category: text, dietary: text, quantity, unit: text,
  prepared_at: timestamp, pickup_from: timestamp, pickup_until: timestamp, address: text,
  latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
  storage: text, packaging: text, safety_declaration: { type: 'boolean', enum: [true] }
});
const profile = object({
  name: text, organization: { type: 'string', maxLength: 300 }, address: { type: 'string', maxLength: 300 },
  latitude: { type: 'number', minimum: -90, maximum: 90, nullable: true },
  longitude: { type: 'number', minimum: -180, maximum: 180, nullable: true },
  service_radius: { type: 'number', exclusiveMinimum: true, minimum: 0, maximum: 1000 },
  capacity: { type: 'number', minimum: 0 }, categories: { type: 'array', items: text, maxItems: 30 },
  dietary: { type: 'array', items: text, maxItems: 30 },
  available_from: { ...timestamp, nullable: true }, available_until: { ...timestamp, nullable: true },
  pickup_ready: { type: 'boolean' }
});
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const responses = (success = '200') => ({
  [success]: { description: 'Success' },
  400: { description: 'Invalid input' }, 401: { description: 'Authentication required or invalid' },
  403: { description: 'Insufficient permissions' }, 404: { description: 'Resource not found' },
  409: { description: 'Conflicting state or unavailable resource' }, 500: { description: 'Server error' }
});
const operation = (tag: string, summary: string, options: { id?: boolean; schema?: object; created?: boolean; public?: boolean } = {}) => ({
  tags: [tag], summary,
  ...(options.id ? { parameters: [idParameter] } : {}),
  ...(options.schema ? { requestBody: body(options.schema) } : {}),
  ...(options.public ? { security: [] } : {}),
  responses: responses(options.created ? '201' : '200')
});

export function openApiSpec(demoMode: boolean) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'AaharGrid API', version: '1.0.0',
      description: demoMode
        ? 'Local demo mode: authentication is disabled. Click Authorize and enter donor, recipient, volunteer, or admin as the demo role. Data is simulated.'
        : 'Use a Cognito access token. Application roles and ownership are enforced by the API.'
    },
    security: [demoMode ? { DemoRole: [] } : { CognitoAccessToken: [] }],
    components: { securitySchemes: demoMode
      ? { DemoRole: { type: 'apiKey', in: 'header', name: 'X-Demo-Role', description: 'Enter donor, recipient, volunteer, or admin.' } }
      : { CognitoAccessToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
    },
    paths: {
      '/api/config': { get: operation('System', 'Get public client configuration', { public: true }) },
      '/api/health': { get: operation('System', 'Check API and database health', { public: true }) },
      '/api/me': {
        get: operation('Profile', 'Get current profile'),
        post: operation('Profile', 'Create profile', { created: true, schema: object({ name: text, role: { type: 'string', enum: ['donor','recipient','volunteer'] }, organization: { type: 'string', maxLength: 300 }, address: { type: 'string', maxLength: 300 } }) }),
        patch: operation('Profile', 'Update profile and preferences', { schema: profile })
      },
      '/api/listings': {
        get: operation('Listings', 'List own listings or eligible matches (donor, recipient, admin)'),
        post: operation('Listings', 'Create a listing (donor)', { created: true, schema: listing })
      },
      '/api/listings/{id}': { patch: operation('Listings', 'Edit an unallocated listing (owner donor)', { id: true, schema: listing }) },
      '/api/listings/{id}/matches': { get: operation('Listings', 'Rank eligible recipients (owner donor, admin)', { id: true }) },
      '/api/listings/{id}/close': { patch: operation('Listings', 'Close a listing (owner donor, admin)', { id: true }) },
      '/api/listings/{id}/requests': { post: operation('Requests', 'Request food (recipient)', { id: true, created: true, schema: object({ quantity }) }) },
      '/api/requests': { get: operation('Requests', 'List scoped requests (donor, recipient, admin)') },
      '/api/requests/{id}/decision': { patch: operation('Requests', 'Accept or reject a request (owner donor)', { id: true, schema: object({ decision: { type: 'string', enum: ['accepted','rejected'] } }) }) },
      '/api/requests/{id}/receipt': { post: operation('Requests', 'Confirm delivered quantity (recipient)', { id: true, schema: object({ quantity }) }) },
      '/api/volunteers': { get: operation('Pickups', 'List approved volunteers (recipient, admin)') },
      '/api/assignments': {
        get: operation('Pickups', 'List scoped assignments (recipient, volunteer, admin)'),
        post: operation('Pickups', 'Assign a volunteer (recipient, admin)', { created: true, schema: object({ request_id: { type: 'integer', minimum: 1 }, volunteer_id: { type: 'integer', minimum: 1 } }) })
      },
      '/api/assignments/{id}/status': { patch: operation('Pickups', 'Update pickup status (assigned volunteer)', { id: true, schema: object({ status: { type: 'string', enum: ['accepted','picked_up','delivered','failed'] } }) }) },
      '/api/notifications': { get: operation('Notifications', 'List current user notifications') },
      '/api/notifications/{id}/read': { patch: operation('Notifications', 'Mark notification as read', { id: true }) },
      '/api/admin/users': { get: operation('Administration', 'Review users (admin)') },
      '/api/admin/users/{id}': { patch: operation('Administration', 'Approve or reject a user (admin)', { id: true, schema: object({ status: { type: 'string', enum: ['approved','rejected'] } }) }) },
      '/api/admin/audit-logs': { get: operation('Administration', 'List recent audit events (admin)') },
      '/api/analytics/overview': { get: operation('Analytics', 'Get role-scoped activity counts') }
    }
  };
}
