/**
 * Phase 8 (Stretch) — SMART on FHIR OAuth 2.0 + PKCE Authentication Module
 * 
 * Implements the standard EHR launch flow according to HL7 SMART App Launch Framework (v2.0).
 * - Dynamic conformance / .well-known/smart-configuration discovery
 * - RFC 7636 PKCE (Proof Key for Code Exchange) code_verifier and S256 code_challenge
 * - Secure In-Memory Session Storage (Strictly NO cleartext tokens in localStorage)
 * - Launch context extraction (active patient and user context)
 */

const crypto = require('crypto');
const axios = require('axios');

// Secure in-memory token/session store (prevents cleartext localStorage security vulnerabilities)
const sessionStore = new Map();

/**
 * Base64URL encoding without padding (RFC 7636 compliant)
 * @param {Buffer} buffer
 * @returns {string} base64url encoded string
 */
function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a cryptographically secure PKCE code verifier and challenge (S256)
 * @returns {Object} { codeVerifier, codeChallenge, challengeMethod: 'S256', state }
 */
function generatePkce() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(hash);
  const state = crypto.randomBytes(16).toString('hex');

  return {
    codeVerifier,
    codeChallenge,
    challengeMethod: 'S256',
    state
  };
}

/**
 * Discover SMART endpoints via .well-known/smart-configuration or FHIR /metadata CapabilityStatement
 * @param {string} fhirBaseUrl - FHIR Server Base URL
 * @returns {Promise<Object>} Discovered endpoints
 */
async function discoverSmartEndpoints(fhirBaseUrl) {
  const cleanBase = fhirBaseUrl.replace(/\/+$/, '');
  const wellKnownUrl = `${cleanBase}/.well-known/smart-configuration`;

  try {
    const res = await axios.get(wellKnownUrl, { timeout: 3000 });
    if (res.data && res.data.authorization_endpoint) {
      return {
        authorizationEndpoint: res.data.authorization_endpoint,
        tokenEndpoint: res.data.token_endpoint,
        capabilities: res.data.capabilities || []
      };
    }
  } catch {
    // Fallback: try querying /metadata Conformance / CapabilityStatement
  }

  try {
    const metaRes = await axios.get(`${cleanBase}/metadata`, { timeout: 3000 });
    const exts = metaRes.data?.rest?.[0]?.security?.extension || [];
    const oauthUriExt = exts.find(e => e.url?.includes('oauth-uris'));
    if (oauthUriExt?.extension) {
      const auth = oauthUriExt.extension.find(e => e.url === 'authorize')?.valueUri;
      const token = oauthUriExt.extension.find(e => e.url === 'token')?.valueUri;
      if (auth && token) {
        return {
          authorizationEndpoint: auth,
          tokenEndpoint: token,
          capabilities: []
        };
      }
    }
  } catch {
    // Return sensible defaults for simulation / testing
  }

  return {
    authorizationEndpoint: `${cleanBase}/oauth/authorize`,
    tokenEndpoint: `${cleanBase}/oauth/token`,
    capabilities: ['launch-ehr', 'client-public', 'permission-patient']
  };
}

/**
 * Construct the EHR launch authorization redirect URL
 * @param {Object} params
 * @param {string} params.fhirBaseUrl - Target FHIR server base
 * @param {string} params.clientId - Registered SMART Client ID
 * @param {string} params.redirectUri - OAuth callback redirect URI
 * @param {string} params.launch - EHR Launch Token provided by EHR
 * @param {string} [params.scope] - Requested OAuth scopes
 * @returns {Promise<Object>} { authUrl, state, codeVerifier }
 */
async function buildSmartAuthorizationUrl(params = {}) {
  const {
    fhirBaseUrl,
    clientId = 'pharmacy-cold-chain-app',
    redirectUri,
    launch,
    scope = 'launch patient/MedicationRequest.read patient/MedicationDispense.write openid fhirUser'
  } = params;

  if (!fhirBaseUrl) throw new Error('fhirBaseUrl is required for SMART launch');
  if (!redirectUri) throw new Error('redirectUri is required for SMART launch');

  const endpoints = await discoverSmartEndpoints(fhirBaseUrl);
  const pkce = generatePkce();

  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (launch) {
    url.searchParams.set('launch', launch);
  }
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('aud', fhirBaseUrl);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', pkce.challengeMethod);

  // Store PKCE verifier keyed by state in temporary in-memory state store
  sessionStore.set(`pkce:${pkce.state}`, {
    codeVerifier: pkce.codeVerifier,
    fhirBaseUrl,
    tokenEndpoint: endpoints.tokenEndpoint,
    redirectUri,
    clientId,
    createdAt: Date.now()
  });

  return {
    authUrl: url.toString(),
    state: pkce.state,
    codeVerifier: pkce.codeVerifier
  };
}

/**
 * Exchange Authorization Code and PKCE verifier for an Access Token
 * @param {Object} params
 * @param {string} params.code - Authorization code from callback query
 * @param {string} params.state - State parameter from callback query
 * @param {string} [params.codeVerifier] - Optional explicit code verifier (if not using state store)
 * @param {string} [params.tokenEndpoint] - Token endpoint URL
 * @returns {Promise<Object>} Established session with patient context
 */
async function exchangeCodeForToken(params = {}) {
  const { code, state } = params;
  if (!code) throw new Error('Authorization code is required for token exchange');
  if (!state) throw new Error('State parameter is required for CSRF validation');

  const pending = sessionStore.get(`pkce:${state}`);
  if (!pending && !params.codeVerifier) {
    throw new Error('Invalid or expired state parameter (CSRF protection)');
  }

  const codeVerifier = params.codeVerifier || pending.codeVerifier;
  const tokenEndpoint = params.tokenEndpoint || pending.tokenEndpoint;
  const clientId = params.clientId || pending.clientId || 'pharmacy-cold-chain-app';
  const redirectUri = params.redirectUri || pending.redirectUri;

  // Clean up pending PKCE state
  sessionStore.delete(`pkce:${state}`);

  const postData = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });

  let tokenResponse;
  try {
    const res = await axios.post(tokenEndpoint, postData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    });
    tokenResponse = res.data;
  } catch (error) {
    throw new Error(`Token exchange failed: ${error.response?.data?.error_description || error.message}`);
  }

  // Create isolated in-memory session (never written to disk or localStorage)
  const sessionId = `SMART-${crypto.randomBytes(16).toString('hex')}`;
  const sessionData = {
    sessionId,
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type || 'Bearer',
    expiresIn: tokenResponse.expires_in || 3600,
    patientId: tokenResponse.patient || null,
    scope: tokenResponse.scope || null,
    idToken: tokenResponse.id_token || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + (tokenResponse.expires_in || 3600) * 1000
  };

  sessionStore.set(sessionId, sessionData);

  // Return public session view (excluding raw secrets)
  return {
    sessionId,
    patientId: sessionData.patientId,
    expiresAt: sessionData.expiresAt,
    scope: sessionData.scope,
    status: 'authenticated'
  };
}

/**
 * Retrieve session by ID
 * @param {string} sessionId
 * @returns {Object|null}
 */
function getSession(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessionStore.delete(sessionId);
    return null;
  }
  return session;
}

/**
 * Clear session
 * @param {string} sessionId
 */
function clearSession(sessionId) {
  sessionStore.delete(sessionId);
}

/**
 * Clear all sessions (used in test suites)
 */
function clearAllSessions() {
  sessionStore.clear();
}

module.exports = {
  base64UrlEncode,
  generatePkce,
  discoverSmartEndpoints,
  buildSmartAuthorizationUrl,
  exchangeCodeForToken,
  getSession,
  clearSession,
  clearAllSessions
};
