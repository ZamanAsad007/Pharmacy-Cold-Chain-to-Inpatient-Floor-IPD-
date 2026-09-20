const request = require('supertest');
const app = require('../src/index');
const { fhirClient } = require('../src/fhir/client');
const {
  buildAuditEvent,
  postAuditEvent,
  logAuditEvent,
  withAudit,
  getAuditEvents,
  getAuditTrailForResource
} = require('../src/audit/logger');
const { createMedicationRequest } = require('../src/fhir/medicationRequest');
const { recordDispenseAndDispatch } = require('../src/fhir/medicationDispense');

describe('Phase 6 — Audit Logging (FHIR AuditEvent)', () => {

  describe('Unit Tests — buildAuditEvent', () => {

    test('constructs valid FHIR R4 AuditEvent resource with correct schema', () => {
      const audit = buildAuditEvent({
        action: 'C',
        subtype: 'create-medication-dispense',
        outcome: '0',
        outcomeDesc: 'Packed and dispatched cold-chain medication',
        entity: 'MedicationDispense/101',
        agent: 'Pharmacist Alex Chen'
      });

      expect(audit.resourceType).toBe('AuditEvent');
      expect(audit.action).toBe('C');
      expect(audit.outcome).toBe('0');
      expect(audit.outcomeDesc).toBe('Packed and dispatched cold-chain medication');
      expect(audit.type.code).toBe('rest');
      expect(audit.subtype[0].code).toBe('create-medication-dispense');
      expect(audit.agent[0].who.display).toBe('Pharmacist Alex Chen');
      expect(audit.entity[0].what.reference).toBe('MedicationDispense/101');
      expect(audit.recorded).toBeDefined();
    });

    test('defaults to success outcome 0 and system agent when omitted', () => {
      const audit = buildAuditEvent({
        action: 'R',
        subtype: 'read-prescription'
      });

      expect(audit.action).toBe('R');
      expect(audit.outcome).toBe('0');
      expect(audit.agent[0].who.display).toBe('Pharmacy Cold Chain Service');
    });

  });

  describe('Integration Tests — FHIR Server Persistence & withAudit Interceptor', () => {
    let testPatientId;
    let testPrescriptionId;
    let testDispenseId;

    beforeAll(async () => {
      // Seed Patient and MedicationRequest
      const patRes = await fhirClient.post('/Patient', {
        resourceType: 'Patient',
        name: [{ family: 'AuditTestPatient', given: ['Alex'] }]
      });
      testPatientId = patRes.data.id;

      const medReqRes = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${testPatientId}` },
        medicationCodeableConcept: { text: 'Insulin Glargine' }
      });
      testPrescriptionId = medReqRes.id;
    });

    test('performs dispense-write action and confirms corresponding AuditEvent is created', async () => {
      let createdId;
      const auditedResult = await withAudit('write-dispense-test', async () => {
        const dispense = await recordDispenseAndDispatch({
          prescriptionId: testPrescriptionId,
          patientRef: `Patient/${testPatientId}`,
          drugName: 'Insulin Glargine',
          packer: 'Pharmacist John',
          courier: 'Courier Mike',
          eta: '2026-09-21T12:00:00.000Z'
        });
        createdId = dispense.id;
        return dispense;
      }, {
        action: 'C',
        getEntityRef: (res) => `MedicationDispense/${res.id}`
      });

      expect(auditedResult).toBeDefined();
      expect(createdId).toBeDefined();
      testDispenseId = createdId;

      // Query the FHIR server for the corresponding AuditEvent
      const events = await getAuditEvents({ entity: `MedicationDispense/${testDispenseId}` });
      expect(events.length).toBeGreaterThanOrEqual(1);

      const matchedEvent = events.find(e =>
        e.subtype?.some(s => s.code === 'write-dispense-test')
      );
      expect(matchedEvent).toBeDefined();
      expect(matchedEvent.action).toBe('C');
      expect(matchedEvent.outcome).toBe('0');
      expect(matchedEvent.entity[0].what.reference).toBe(`MedicationDispense/${testDispenseId}`);
    });

    test('failed action is logged as an AuditEvent with failure outcome', async () => {
      const failureActionName = 'failing-dispense-operation';

      await expect(
        withAudit(failureActionName, async () => {
          throw new Error('Database connection dropped');
        }, {
          action: 'C',
          entityRef: 'MedicationDispense/failed-attempt-1'
        })
      ).rejects.toThrow('Database connection dropped');

      // Verify the failed action was recorded with outcome '4'
      const events = await getAuditEvents({ entity: 'MedicationDispense/failed-attempt-1' });
      expect(events.length).toBeGreaterThanOrEqual(1);

      const failedEvent = events.find(e =>
        e.subtype?.some(s => s.code === failureActionName)
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent.outcome).toBe('4');
      expect(failedEvent.outcomeDesc).toContain('Database connection dropped');
    });

    test('reconstructs chronological audit trail for a resource', async () => {
      // Add a read audit event for the prescription
      await logAuditEvent({
        action: 'R',
        subtype: 'read-prescription',
        outcome: '0',
        outcomeDesc: 'Nurse queried prescription',
        entity: `MedicationRequest/${testPrescriptionId}`
      });

      // Add a secondary audit event for the same prescription
      await logAuditEvent({
        action: 'E',
        subtype: 'validate-drug',
        outcome: '0',
        outcomeDesc: 'Validated drug against RxNorm',
        entity: `MedicationRequest/${testPrescriptionId}`
      });

      const trail = await getAuditTrailForResource(`MedicationRequest/${testPrescriptionId}`);
      expect(trail.length).toBeGreaterThanOrEqual(2);

      // Verify chronological ordering
      for (let i = 0; i < trail.length - 1; i++) {
        const t1 = new Date(trail[i].recorded).getTime();
        const t2 = new Date(trail[i + 1].recorded).getTime();
        expect(t1).toBeLessThanOrEqual(t2);
      }
    });

  });

  describe('Express API Endpoint Tests', () => {

    test('GET /api/audit returns list of all recent audit events from FHIR server', async () => {
      const res = await request(app).get('/api/audit?limit=10');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.count).toBeGreaterThanOrEqual(1);
    });

    test('GET /api/audit/trail/:resourceType/:id returns chronological trail for specific resource', async () => {
      // Create a dedicated patient to have a clean, isolated audit trail
      const patRes = await fhirClient.post('/Patient', {
        resourceType: 'Patient',
        name: [{ family: 'TrailAuditPatient', given: ['Trail'] }]
      });
      const pId = patRes.data.id;

      // Log two distinct events on this patient
      await logAuditEvent({
        action: 'C',
        subtype: 'patient-registered',
        outcome: '0',
        entity: `Patient/${pId}`
      });

      await logAuditEvent({
        action: 'R',
        subtype: 'patient-verified',
        outcome: '0',
        entity: `Patient/${pId}`
      });

      const res = await request(app).get(`/api/audit/trail/Patient/${pId}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.resource).toBe(`Patient/${pId}`);
      expect(res.body.count).toBe(2);
      expect(res.body.data[0].subtype[0].code).toBe('patient-registered');
      expect(res.body.data[1].subtype[0].code).toBe('patient-verified');
    });

  });

});
