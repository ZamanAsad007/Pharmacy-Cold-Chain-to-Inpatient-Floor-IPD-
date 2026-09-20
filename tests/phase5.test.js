const request = require('supertest');
const app = require('../src/index');
const { fhirClient } = require('../src/fhir/client');
const {
  BLOCKED_PHI_FIELDS,
  deriveMedicationCategory,
  sanitizeForNurseNotification,
  verifyZeroPhi,
  sendNurseNotification,
  getNotificationHistory,
  clearNotificationHistory
} = require('../src/notify/sanitizer');
const { createMedicationRequest } = require('../src/fhir/medicationRequest');
const { recordDispenseAndDispatch } = require('../src/fhir/medicationDispense');

describe('Phase 5 — Strip Private Data and Build the Nurse Notification', () => {

  beforeAll(() => {
    clearNotificationHistory();
  });

  const fullRecordWithPhi = {
    id: 'dispense-888',
    status: 'in-progress',
    patient: {
      id: 'pat-999',
      name: 'Jane Smith',
      birthDate: '1985-04-12',
      mrn: 'MRN-12345',
      roomNumber: '302-B',
      bed: 'Bed-1',
      ssn: '000-12-3456'
    },
    patientRef: 'Patient/pat-999',
    subject: {
      reference: 'Patient/pat-999',
      display: 'Jane Smith'
    },
    drugName: 'Insulin Glargine 100 UNT/ML Injectable Solution',
    rxNormCode: '313782',
    courier: {
      name: 'Courier Maria Rodriguez',
      reference: 'Practitioner/courier-01'
    },
    packer: {
      name: 'Pharmacist Alex Chen',
      reference: 'Practitioner/pharm-01'
    },
    eta: '2026-09-21T10:30:00.000Z',
    whenPrepared: '2026-09-21T09:15:00.000Z',
    whenHandedOver: '2026-09-21T09:20:00.000Z'
  };

  describe('Unit Tests — sanitizeForNurseNotification (Data Minimization & PHI Stripping)', () => {

    test('strips all Protected Health Information (PHI) fields from outbound alert', () => {
      const sanitized = sanitizeForNurseNotification(fullRecordWithPhi);

      // Verify none of the blocked PHI fields exist anywhere in output
      for (const field of BLOCKED_PHI_FIELDS) {
        expect(sanitized).not.toHaveProperty(field);
      }

      // Explicit checks for common hospital leaks
      expect(sanitized.patient).toBeUndefined();
      expect(sanitized.patientName).toBeUndefined();
      expect(sanitized.patientRef).toBeUndefined();
      expect(sanitized.subject).toBeUndefined();
      expect(sanitized.mrn).toBeUndefined();
      expect(sanitized.birthDate).toBeUndefined();
      expect(sanitized.roomNumber).toBeUndefined();
      expect(sanitized.bed).toBeUndefined();
      expect(sanitized.ssn).toBeUndefined();

      // Serialized check to ensure no substring leakage
      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain('Jane Smith');
      expect(serialized).not.toContain('Patient/pat-999');
      expect(serialized).not.toContain('1985-04-12');
      expect(serialized).not.toContain('302-B');
    });

    test('preserves necessary operational logistics (courier, ETA, category, storage requirements)', () => {
      const sanitized = sanitizeForNurseNotification(fullRecordWithPhi);

      expect(sanitized.dispenseId).toBe('dispense-888');
      expect(sanitized.courier).toBe('Courier Maria Rodriguez');
      expect(sanitized.estimatedArrival).toBe('2026-09-21T10:30:00.000Z');
      expect(sanitized.medicationCategory).toBe('Refrigerated Biologic / Insulin');
      expect(sanitized.storageCondition).toContain('2-8°C');
      expect(sanitized.destinationStation).toBe('Inpatient Floor Nursing Station');
      expect(sanitized.requiresImmediateRefrigeration).toBe(true);
      expect(sanitized.status).toBe('in-transit');
    });

    test('side-by-side comparison confirms before and after sanitization', () => {
      const before = fullRecordWithPhi;
      const after = sanitizeForNurseNotification(before);

      // Before has PHI
      expect(before.patient.name).toBe('Jane Smith');
      expect(before.patient.roomNumber).toBe('302-B');

      // After has zero PHI
      expect(after.patient).toBeUndefined();
      expect(after.patientName).toBeUndefined();
      expect(after.roomNumber).toBeUndefined();

      // Passes zero-PHI assertion
      expect(() => verifyZeroPhi(after)).not.toThrow();
    });

    test('correctly maps various drugs to generalized categories without exposing sensitive formulations', () => {
      expect(deriveMedicationCategory('Insulin Glargine')).toBe('Refrigerated Biologic / Insulin');
      expect(deriveMedicationCategory('Influenza Vaccine Quadrivalent')).toBe('Refrigerated Biologic / Vaccine');
      expect(deriveMedicationCategory('Amoxicillin 500mg Oral Capsule')).toBe('Inpatient Antibiotic');
      expect(deriveMedicationCategory('Cisplatin 50mg Injection')).toBe('Specialty Oncology (Refrigerated)');
      expect(deriveMedicationCategory('Unknown Generic Compound')).toBe('Temperature-Controlled Inpatient Medication');
    });

    test('handles raw FHIR MedicationDispense resource directly', () => {
      const rawFhirDispense = {
        resourceType: 'MedicationDispense',
        id: 'disp-raw-12',
        status: 'in-progress',
        subject: { reference: 'Patient/11' },
        performer: [
          {
            function: { coding: [{ code: 'courier' }] },
            actor: { display: 'Courier Maria' }
          }
        ],
        extension: [
          {
            url: 'http://pharmacy-cold-chain.org/fhir/StructureDefinition/expected-delivery-time',
            valueDateTime: '2026-09-21T11:15:00.000Z'
          }
        ],
        medicationCodeableConcept: {
          text: 'Insulin Lispro 100 U/mL'
        }
      };

      const sanitized = sanitizeForNurseNotification(rawFhirDispense);
      expect(sanitized.dispenseId).toBe('disp-raw-12');
      expect(sanitized.courier).toBe('Courier Maria');
      expect(sanitized.estimatedArrival).toBe('2026-09-21T11:15:00.000Z');
      expect(sanitized.medicationCategory).toBe('Refrigerated Biologic / Insulin');
      expect(sanitized).not.toHaveProperty('subject');
      expect(sanitized).not.toHaveProperty('patient');
    });

  });

  describe('Unit Tests — verifyZeroPhi Leakage Detection', () => {

    test('detects and throws error if patient name key is present', () => {
      const leakingPayload = {
        courier: 'Courier Dave',
        patientName: 'John Doe'
      };

      expect(() => verifyZeroPhi(leakingPayload))
        .toThrow(/PHI Leakage Detected! Blocked key 'patientName'/);
    });

    test('detects and throws error if roomNumber key is present', () => {
      const leakingPayload = {
        courier: 'Courier Dave',
        roomNumber: 'Room 401'
      };

      expect(() => verifyZeroPhi(leakingPayload))
        .toThrow(/PHI Leakage Detected! Blocked key 'roomNumber'/);
    });

    test('detects and throws error if patient reference is serialized', () => {
      const leakingPayload = {
        courier: 'Courier Dave',
        customMetadata: { ref: 'Patient/12345' }
      };

      expect(() => verifyZeroPhi(leakingPayload))
        .toThrow(/PHI Leakage Detected! Patient reference found/);
    });

  });

  describe('Unit Tests — sendNurseNotification & Dispatch History', () => {

    test('dispatches notification and saves receipt in history', async () => {
      const sanitized = sanitizeForNurseNotification(fullRecordWithPhi);
      const receipt = await sendNurseNotification(sanitized, { channel: 'Push Alert' });

      expect(receipt.success).toBe(true);
      expect(receipt.receiptId).toBeDefined();
      expect(receipt.channel).toBe('Push Alert');
      expect(receipt.notification.dispenseId).toBe('dispense-888');

      const history = getNotificationHistory();
      expect(history).toHaveLength(1);
      expect(history[0].receiptId).toBe(receipt.receiptId);
    });

    test('refuses to dispatch if PHI is present in payload', async () => {
      const dirtyPayload = {
        courier: 'Courier Dave',
        patientName: 'Jane Smith'
      };

      await expect(sendNurseNotification(dirtyPayload))
        .rejects.toThrow(/PHI Leakage Detected/);
    });

  });

  describe('Express API Endpoint Tests', () => {
    let testDispenseId;

    beforeAll(async () => {
      // Create Patient, Practitioner, MedicationRequest, and MedicationDispense on local FHIR server
      const patRes = await fhirClient.post('/Patient', {
        resourceType: 'Patient',
        name: [{ family: 'Phase5Patient', given: ['Test'] }]
      });

      const medReqRes = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${patRes.data.id}` },
        medicationCodeableConcept: { text: 'Insulin Glargine 100 UNT/ML' }
      });

      const dispenseRecord = await recordDispenseAndDispatch({
        prescriptionId: medReqRes.id,
        patientRef: `Patient/${patRes.data.id}`,
        drugName: 'Insulin Glargine 100 UNT/ML',
        packer: 'Pharmacist Sarah',
        courier: 'Courier Tim',
        eta: '2026-09-21T11:45:00.000Z'
      });

      testDispenseId = dispenseRecord.id;
    });

    test('POST /api/notify/nurse creates and dispatches sanitized alert by dispenseId', async () => {
      const res = await request(app)
        .post('/api/notify/nurse')
        .send({ dispenseId: testDispenseId });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.receipt).toBeDefined();

      const payload = res.body.data.sanitizedPayload;
      expect(payload.dispenseId).toBe(testDispenseId);
      expect(payload.courier).toBe('Courier Tim');
      expect(payload.medicationCategory).toBe('Refrigerated Biologic / Insulin');

      // Assert zero PHI in the API response payload
      expect(payload).not.toHaveProperty('patient');
      expect(payload).not.toHaveProperty('subject');
      expect(payload).not.toHaveProperty('patientRef');
    });

    test('POST /api/notify/nurse creates sanitized alert from direct dispenseRecord body', async () => {
      const res = await request(app)
        .post('/api/notify/nurse')
        .send({ dispenseRecord: fullRecordWithPhi });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sanitizedPayload.courier).toBe('Courier Maria Rodriguez');
      expect(res.body.data.sanitizedPayload).not.toHaveProperty('patient');
    });

    test('POST /api/notify/nurse returns 400 when neither dispenseId nor dispenseRecord is sent', async () => {
      const res = await request(app)
        .post('/api/notify/nurse')
        .send({});

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Either dispenseRecord or valid dispenseId must be provided');
    });

    test('GET /api/notify/history returns all dispatched alerts', async () => {
      // Send a notification first to ensure history is populated
      await request(app)
        .post('/api/notify/nurse')
        .send({ dispenseRecord: fullRecordWithPhi });

      const res = await request(app).get('/api/notify/history');

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });

  });

});
