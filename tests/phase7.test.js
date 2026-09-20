const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/index');
const { fhirClient } = require('../src/fhir/client');
const { createMedicationRequest } = require('../src/fhir/medicationRequest');
const { runColdChainPipeline } = require('../src/orchestrator');
const { getAuditEvents, getAuditTrailForResource } = require('../src/audit/logger');
const { rxNavClient } = require('../src/rxnorm/validator');

describe('Phase 7 — Wire It All Together (End-to-End Flow)', () => {

  const sampleHl7Path = path.join(__dirname, '..', 'sample-data', 'hl7-omp-o09-sample.hl7');
  const sampleHl7 = fs.readFileSync(sampleHl7Path, 'utf8');

  let validPatientId;
  let validPrescriptionId;

  beforeAll(async () => {
    // Seed real FHIR Patient
    const patRes = await fhirClient.post('/Patient', {
      resourceType: 'Patient',
      name: [{ family: 'PipelinePatient', given: ['E2E'] }]
    });
    validPatientId = patRes.data.id;

    // Seed real FHIR MedicationRequest for Insulin Glargine
    const medReqRes = await createMedicationRequest({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${validPatientId}` },
      medicationCodeableConcept: {
        coding: [
          {
            system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            code: '313782',
            display: 'Insulin Glargine 100 UNT/ML Injectable Solution'
          }
        ],
        text: 'Insulin Glargine 100 UNT/ML Injectable Solution'
      },
      dosageInstruction: [{ text: '10 units subcutaneously once daily' }]
    });
    validPrescriptionId = medReqRes.id;
  });

  describe('Happy Path — Complete End-to-End Execution', () => {

    test('executes full story from prescription read to nurse alert and audit logging', async () => {
      // Mock RxNav calls to guarantee determinism in test suite
      jest.spyOn(rxNavClient, 'get').mockImplementation((url, config) => {
        if (url === '/rxcui.json' || url === '/approximateTerm.json') {
          return Promise.resolve({ data: { idGroup: { rxnormId: ['313782'] } } });
        }
        if (url === '/rxcui/313782/properties.json') {
          return Promise.resolve({
            data: {
              properties: {
                rxcui: '313782',
                name: 'Insulin Glargine 100 UNT/ML Injectable Solution'
              }
            }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await runColdChainPipeline({
        prescriptionId: validPrescriptionId,
        hl7Message: sampleHl7,
        packer: 'Pharmacist Alex Chen',
        courier: 'Courier Maria Rodriguez',
        eta: '2026-09-21T13:00:00.000Z',
        destinationStation: 'Floor 3 Inpatient Ward'
      });

      // Assert entire pipeline succeeded
      expect(result.success).toBe(true);
      expect(result.pipelineId).toBeDefined();
      expect(result.summary).toContain(`prescription ${validPrescriptionId}`);

      // Stage 1: Read Prescription
      expect(result.stages.prescription).toBeDefined();
      expect(result.stages.prescription.id).toBe(validPrescriptionId);
      expect(result.stages.prescription.drugName).toContain('Insulin Glargine');
      expect(result.stages.prescription.patientRef).toBe(`Patient/${validPatientId}`);

      // Stage 2: Drug Validation (RxNorm)
      expect(result.stages.drugValidation).toBeDefined();
      expect(result.stages.drugValidation.valid).toBe(true);
      expect(result.stages.drugValidation.rxNormCode).toBe('313782');

      // Stage 3: Legacy HL7 Message Parsing
      expect(result.stages.hl7).toBeDefined();
      expect(result.stages.hl7.messageType).toBe('OMP^O09');
      expect(result.stages.hl7.isColdChain).toBe(true);

      // Stage 4: Dispense Record on Server
      expect(result.stages.dispense).toBeDefined();
      expect(result.stages.dispense.id).toBeDefined();
      expect(result.stages.dispense.status).toBe('in-progress');
      expect(result.stages.dispense.courier.name).toBe('Courier Maria Rodriguez');

      // Stage 5: Zero-PHI Nurse Notification
      expect(result.stages.notification).toBeDefined();
      expect(result.stages.notification.receiptId).toBeDefined();
      const notif = result.stages.notification.sanitizedPayload;
      expect(notif.medicationCategory).toBe('Refrigerated Biologic / Insulin');
      expect(notif.courier).toBe('Courier Maria Rodriguez');
      expect(notif.requiresImmediateRefrigeration).toBe(true);
      expect(notif).not.toHaveProperty('patient');
      expect(notif).not.toHaveProperty('patientRef');
      expect(notif).not.toHaveProperty('subject');

      // Audit Verification: Verify that AuditEvents were logged on FHIR server
      const trail = await getAuditTrailForResource(`MedicationRequest/${validPrescriptionId}`);
      expect(trail.length).toBeGreaterThanOrEqual(1);

      jest.restoreAllMocks();
    });

  });

  describe('Failure Path — Safety and Traceability', () => {

    test('deliberately wrong drug halts pipeline safely at validation stage and logs failure', async () => {
      // Create a prescription with an unrecognized invalid medication
      const badMedReq = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${validPatientId}` },
        medicationCodeableConcept: {
          text: 'CompletelyInvalidNonExistentDrugXYZ999'
        }
      });

      // Mock RxNav to reject the fake drug
      jest.spyOn(rxNavClient, 'get').mockImplementation((url) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({ data: { idGroup: {} } });
        }
        if (url === '/approximateTerm.json') {
          return Promise.resolve({ data: { approximateGroup: { candidate: [] } } });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await runColdChainPipeline({
        prescriptionId: badMedReq.id
      });

      // Assert safe pipeline termination
      expect(result.success).toBe(false);
      expect(result.failedAt).toBeDefined();
      expect(result.error).toContain('not found in RxNorm database');

      // Confirm dispense and notification were NEVER created
      expect(result.stages?.dispense).toBeUndefined();
      expect(result.stages?.notification).toBeUndefined();

      // Confirm failure audit event was logged on the FHIR server
      const events = await getAuditEvents({ entity: `MedicationRequest/${badMedReq.id}` });
      const failEvent = events.find(e => e.outcome === '4' || e.subtype?.some(s => s.code.includes('failure')));
      expect(failEvent).toBeDefined();

      jest.restoreAllMocks();
    });

    test('non-existent prescription ID safely halts with descriptive error', async () => {
      const result = await runColdChainPipeline({
        prescriptionId: 'non-existent-rx-999999'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('missing prescription ID fails at input-validation stage', async () => {
      const result = await runColdChainPipeline({});

      expect(result.success).toBe(false);
      expect(result.failedStage).toBe('input-validation');
    });

  });

  describe('Express API Endpoint — POST /api/pipeline/run', () => {

    test('POST /api/pipeline/run runs full pipeline via HTTP API and returns 200', async () => {
      // Mock RxNav for fast, reliable run
      jest.spyOn(rxNavClient, 'get').mockImplementation((url) => {
        if (url === '/rxcui.json' || url === '/approximateTerm.json') {
          return Promise.resolve({ data: { idGroup: { rxnormId: ['313782'] } } });
        }
        if (url === '/rxcui/313782/properties.json') {
          return Promise.resolve({
            data: { properties: { rxcui: '313782', name: 'Insulin Glargine' } }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const res = await request(app)
        .post('/api/pipeline/run')
        .send({
          prescriptionId: validPrescriptionId,
          packer: 'Pharmacist Sarah',
          courier: 'Courier Dave',
          destinationStation: 'Floor 3 Station'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stages.dispense).toBeDefined();
      expect(res.body.stages.notification.sanitizedPayload.courier).toBe('Courier Dave');

      jest.restoreAllMocks();
    });

    test('POST /api/pipeline/run returns 400 when prescriptionId is missing', async () => {
      const res = await request(app)
        .post('/api/pipeline/run')
        .send({});

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.failedStage).toBe('input-validation');
    });

  });

});
