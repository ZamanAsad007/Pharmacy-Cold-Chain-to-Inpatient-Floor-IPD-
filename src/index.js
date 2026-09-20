require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { checkFhirServer } = require('./fhir/client');
const {
  getPrescriptionById,
  createMedicationRequest
} = require('./fhir/medicationRequest');
const {
  validateDrug,
  validatePrescription
} = require('./rxnorm/validator');
const {
  parseOmpO09
} = require('./hl7v2/parser');
const {
  getDispenseById,
  createMedicationDispense,
  recordDispenseAndDispatch
} = require('./fhir/medicationDispense');
const {
  sanitizeForNurseNotification,
  sendNurseNotification,
  getNotificationHistory
} = require('./notify/sanitizer');
const {
  withAudit,
  getAuditEvents,
  getAuditTrailForResource
} = require('./audit/logger');
const {
  runColdChainPipeline
} = require('./orchestrator');
const {
  buildSmartAuthorizationUrl,
  exchangeCodeForToken,
  getSession
} = require('./auth/smartAuth');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['text/plain', 'application/hl7-v2', 'application/x-hl7'] }));

// Health Check
app.get('/health', async (req, res) => {
  const fhirHealth = await checkFhirServer();
  res.json({
    status: 'ok',
    service: 'pharmacy-cold-chain',
    fhirServer: fhirHealth
  });
});

// Phase 1: Fetch and parse prescription record (with Phase 6 AuditEvent)
app.get('/api/prescriptions/:id', async (req, res) => {
  try {
    const prescription = await withAudit('read-prescription', () => getPrescriptionById(req.params.id), {
      action: 'R',
      entityRef: `MedicationRequest/${req.params.id}`
    });
    res.json({
      success: true,
      data: prescription
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

// Create prescription endpoint (helper for testing/seeding)
app.post('/api/prescriptions', async (req, res) => {
  try {
    const createdResource = await createMedicationRequest(req.body);
    res.status(201).json({
      success: true,
      data: createdResource
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 2: Validate drug against RxNorm
app.post('/api/validate-drug', async (req, res) => {
  try {
    const { drugName, rxNormCode } = req.body;
    const result = await validateDrug(drugName, rxNormCode);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 2: Fetch prescription and validate its drug in one call
app.get('/api/prescriptions/:id/validate', async (req, res) => {
  try {
    const prescription = await getPrescriptionById(req.params.id);
    const validation = await validatePrescription(prescription);
    res.json({
      success: true,
      data: validation
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 3: Parse legacy HL7 v2 OMP^O09 message
app.post('/api/hl7/parse', (req, res) => {
  const rawMessage = typeof req.body === 'string' ? req.body : req.body.message;
  const result = parseOmpO09(rawMessage);

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json(result);
});

// Phase 4: Create MedicationDispense record and confirm by read-back (with Phase 6 AuditEvent)
app.post('/api/dispenses', async (req, res) => {
  try {
    const dispense = await withAudit('create-medication-dispense', () => recordDispenseAndDispatch(req.body), {
      action: 'C',
      getEntityRef: (r) => `MedicationDispense/${r.id}`,
      entityRef: req.body.prescriptionId ? `MedicationRequest/${req.body.prescriptionId}` : null
    });
    res.status(201).json({
      success: true,
      data: dispense
    });
  } catch (error) {
    const isClientError = error.message.includes('required') ||
      error.message.includes('not found') ||
      error.message.includes('Invalid');
    res.status(isClientError ? 400 : 500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 4: Fetch MedicationDispense record by ID
app.get('/api/dispenses/:id', async (req, res) => {
  try {
    const dispense = await getDispenseById(req.params.id);
    res.json({
      success: true,
      data: dispense
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 5: Generate sanitized nurse notification and mock dispatch (with Phase 6 AuditEvent)
app.post('/api/notify/nurse', async (req, res) => {
  try {
    let dispenseRecord = req.body.dispenseRecord;
    if (!dispenseRecord && req.body.dispenseId) {
      dispenseRecord = await getDispenseById(req.body.dispenseId);
    }
    if (!dispenseRecord) {
      return res.status(400).json({
        success: false,
        error: 'Either dispenseRecord or valid dispenseId must be provided'
      });
    }

    const result = await withAudit('dispatch-nurse-notification', async () => {
      const sanitizedPayload = sanitizeForNurseNotification(dispenseRecord, req.body.options);
      const receipt = await sendNurseNotification(sanitizedPayload, req.body.channelOptions);
      return { receipt, sanitizedPayload };
    }, {
      action: 'E',
      entityRef: `MedicationDispense/${dispenseRecord.id}`
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(error.message.includes('PHI Leakage') ? 500 : 400).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 5: Retrieve notification dispatch history
app.get('/api/notify/history', (req, res) => {
  res.json({
    success: true,
    data: getNotificationHistory()
  });
});

// Phase 6: Query AuditEvents from FHIR server
app.get('/api/audit', async (req, res) => {
  try {
    const events = await getAuditEvents(req.query);
    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 6: Reconstruct chronological audit trail for any resource
app.get('/api/audit/trail/:resourceType/:id', async (req, res) => {
  try {
    const resourceRef = `${req.params.resourceType}/${req.params.id}`;
    const trail = await getAuditTrailForResource(resourceRef);
    res.json({
      success: true,
      resource: resourceRef,
      count: trail.length,
      data: trail
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 7: Trigger end-to-end pharmacy cold chain pipeline
app.post('/api/pipeline/run', async (req, res) => {
  try {
    const result = await runColdChainPipeline(req.body);
    const statusCode = result.success ? 200 : (result.failedStage === 'input-validation' ? 400 : 422);
    res.status(statusCode).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 8: SMART on FHIR EHR Launch Endpoint (PKCE)
app.get('/api/auth/smart/launch', async (req, res) => {
  try {
    const fhirBaseUrl = req.query.iss || process.env.FHIR_BASE_URL || 'http://localhost:8088/fhir';
    const redirectUri = req.query.redirect_uri || `${req.protocol}://${req.get('host')}/api/auth/smart/callback`;
    const launch = req.query.launch;

    const authData = await buildSmartAuthorizationUrl({
      fhirBaseUrl,
      redirectUri,
      launch,
      clientId: req.query.client_id || 'pharmacy-cold-chain-app'
    });

    if (req.query.mode === 'redirect') {
      return res.redirect(authData.authUrl);
    }

    res.json({
      success: true,
      data: authData
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 8: SMART on FHIR OAuth Callback (Token Exchange via PKCE)
app.get('/api/auth/smart/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({
        success: false,
        error: 'Both code and state are required in SMART callback'
      });
    }

    const session = await exchangeCodeForToken({ code, state });
    res.json({
      success: true,
      message: 'SMART on FHIR PKCE login successful. Zero cleartext tokens stored in localStorage.',
      data: session
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Phase 8: Get active session context
app.get('/api/auth/smart/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found or expired'
    });
  }

  res.json({
    success: true,
    data: {
      sessionId: session.sessionId,
      patientId: session.patientId,
      expiresAt: session.expiresAt,
      scope: session.scope,
      status: 'active'
    }
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Pharmacy Cold Chain service listening on port ${port}`);
  });
}

module.exports = app;
