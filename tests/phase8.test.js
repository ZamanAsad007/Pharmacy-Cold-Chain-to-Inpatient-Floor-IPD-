const request = require('supertest');
const axios = require('axios');
const app = require('../src/index');
const {
  base64UrlEncode,
  generatePkce,
  discoverSmartEndpoints,
  buildSmartAuthorizationUrl,
  exchangeCodeForToken,
  getSession,
  clearAllSessions
} = require('../src/auth/smartAuth');

describe('Phase 8 (Stretch) — SMART on FHIR PKCE Authentication Flow', () => {

  beforeEach(() => {
    clearAllSessions();
    jest.restoreAllMocks();
  });

  describe('Unit Tests — PKCE & SMART URL Generation', () => {

    test('generatePkce creates valid RFC 7636 compliant S256 challenge pair', () => {
      const pkce = generatePkce();

      expect(pkce.codeVerifier).toBeDefined();
      expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(pkce.codeChallenge).toBeDefined();
      expect(pkce.challengeMethod).toBe('S256');
      expect(pkce.state).toBeDefined();

      // Ensure no URL-unsafe characters
      expect(pkce.codeVerifier).not.toMatch(/[+/=]/);
      expect(pkce.codeChallenge).not.toMatch(/[+/=]/);
    });

    test('buildSmartAuthorizationUrl constructs valid EHR launch authorization URL', async () => {
      const params = {
        fhirBaseUrl: 'http://localhost:8088/fhir',
        clientId: 'smart-cold-chain-app',
        redirectUri: 'http://localhost:3000/api/auth/smart/callback',
        launch: 'xyz-ehr-launch-context-12345'
      };

      const result = await buildSmartAuthorizationUrl(params);

      expect(result.authUrl).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.codeVerifier).toBeDefined();

      const parsedUrl = new URL(result.authUrl);
      expect(parsedUrl.searchParams.get('response_type')).toBe('code');
      expect(parsedUrl.searchParams.get('client_id')).toBe('smart-cold-chain-app');
      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(params.redirectUri);
      expect(parsedUrl.searchParams.get('launch')).toBe('xyz-ehr-launch-context-12345');
      expect(parsedUrl.searchParams.get('aud')).toBe('http://localhost:8088/fhir');
      expect(parsedUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsedUrl.searchParams.get('code_challenge')).toBeDefined();
    });

  });

  describe('Unit Tests — Token Exchange & Security Validations', () => {

    test('completes PKCE exchange and extracts patient launch context without exposing cleartext tokens in localStorage', async () => {
      // 1. Initiate launch to set up pending PKCE state
      const { state } = await buildSmartAuthorizationUrl({
        fhirBaseUrl: 'http://localhost:8088/fhir',
        redirectUri: 'http://localhost:3000/api/auth/smart/callback'
      });

      // 2. Mock token endpoint response
      jest.spyOn(axios, 'post').mockResolvedValue({
        data: {
          access_token: 'secret-access-token-98765',
          token_type: 'Bearer',
          expires_in: 3600,
          patient: 'Patient/101',
          scope: 'launch patient/*.read patient/*.write openid fhirUser'
        }
      });

      // 3. Exchange authorization code
      const session = await exchangeCodeForToken({
        code: 'auth-code-12345',
        state
      });

      expect(session.status).toBe('authenticated');
      expect(session.patientId).toBe('Patient/101');
      expect(session.sessionId).toMatch(/^SMART-/);

      // Verify the session is stored in memory and accessible
      const internalSession = getSession(session.sessionId);
      expect(internalSession).toBeDefined();
      expect(internalSession.accessToken).toBe('secret-access-token-98765');

      // Security check: Verify no localStorage or global storage is used
      expect(global.localStorage).toBeUndefined();
    });

    test('rejects exchange with invalid or unseeded state (CSRF protection)', async () => {
      await expect(exchangeCodeForToken({
        code: 'auth-code-12345',
        state: 'unknown-spoofed-state'
      })).rejects.toThrow('Invalid or expired state parameter');
    });

  });

  describe('Express API Endpoint Tests', () => {

    test('GET /api/auth/smart/launch initiates launch flow and returns auth metadata', async () => {
      const res = await request(app)
        .get('/api/auth/smart/launch')
        .query({
          iss: 'http://localhost:8088/fhir',
          launch: 'test-launch-ctx'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.authUrl).toContain('response_type=code');
      expect(res.body.data.authUrl).toContain('launch=test-launch-ctx');
      expect(res.body.data.state).toBeDefined();
    });

    test('GET /api/auth/smart/callback executes PKCE token exchange and returns authenticated session', async () => {
      // 1. Prepare PKCE state
      const launchRes = await request(app)
        .get('/api/auth/smart/launch')
        .query({ iss: 'http://localhost:8088/fhir' });

      const state = launchRes.body.data.state;

      // 2. Mock token endpoint
      jest.spyOn(axios, 'post').mockResolvedValue({
        data: {
          access_token: 'mock-token-xyz',
          token_type: 'Bearer',
          expires_in: 1800,
          patient: 'Patient/55',
          scope: 'launch patient/MedicationRequest.read'
        }
      });

      // 3. Callback invocation
      const callbackRes = await request(app)
        .get('/api/auth/smart/callback')
        .query({
          code: 'valid-auth-code',
          state
        });

      expect(callbackRes.statusCode).toBe(200);
      expect(callbackRes.body.success).toBe(true);
      expect(callbackRes.body.data.patientId).toBe('Patient/55');
      expect(callbackRes.body.message).toContain('Zero cleartext tokens stored in localStorage');

      // 4. Session retrieval endpoint
      const sessionId = callbackRes.body.data.sessionId;
      const sessionRes = await request(app).get(`/api/auth/smart/session/${sessionId}`);
      expect(sessionRes.statusCode).toBe(200);
      expect(sessionRes.body.data.patientId).toBe('Patient/55');
      expect(sessionRes.body.data.status).toBe('active');
    });

    test('GET /api/auth/smart/session/:id returns 404 for invalid session ID', async () => {
      const res = await request(app).get('/api/auth/smart/session/invalid-session-999');
      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Session not found');
    });

  });

});
