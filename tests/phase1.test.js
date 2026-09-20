const request = require('supertest');
const app = require('../src/index');
const {
  parseMedicationRequest,
  getPrescriptionById,
  createMedicationRequest
} = require('../src/fhir/medicationRequest');

describe('Phase 1 — Read the Prescription (MedicationRequest)', () => {

  const sampleResource = {
    resourceType: 'MedicationRequest',
    id: 'sample-101',
    status: 'active',
    intent: 'order',
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
    subject: {
      reference: 'Patient/1'
    },
    dosageInstruction: [
      {
        text: '10 units subcutaneously once daily at bedtime'
      }
    ]
  };

  describe('Unit Tests — parseMedicationRequest', () => {

    test('extracts drug name, rxNormCode, patientRef, and dosage correctly', () => {
      const parsed = parseMedicationRequest(sampleResource);

      expect(parsed.id).toBe('sample-101');
      expect(parsed.status).toBe('active');
      expect(parsed.intent).toBe('order');
      expect(parsed.drugName).toBe('Insulin Glargine 100 UNT/ML Injectable Solution');
      expect(parsed.rxNormCode).toBe('313782');
      expect(parsed.system).toBe('http://www.nlm.nih.gov/research/umls/rxnorm');
      expect(parsed.patientRef).toBe('Patient/1');
      expect(parsed.dosage).toBe('10 units subcutaneously once daily at bedtime');
    });

    test('throws error when non-MedicationRequest resource is provided', () => {
      expect(() => parseMedicationRequest({ resourceType: 'Patient' }))
        .toThrow('Invalid resource type. Expected MedicationRequest.');
    });

    test('handles missing fields gracefully', () => {
      const minimalResource = {
        resourceType: 'MedicationRequest',
        id: 'min-1'
      };

      const parsed = parseMedicationRequest(minimalResource);
      expect(parsed.id).toBe('min-1');
      expect(parsed.drugName).toBe('Unknown Drug');
      expect(parsed.rxNormCode).toBeNull();
      expect(parsed.dosage).toBe('No dosage specified');
      expect(parsed.patientRef).toBeNull();
    });

  });

  describe('Integration Tests — FHIR Server & Express API', () => {
    let createdId;

    beforeAll(async () => {
      // Seed a sample MedicationRequest on the local FHIR server
      const created = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
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
        subject: {
          reference: 'Patient/1'
        },
        dosageInstruction: [
          {
            text: '10 units subcutaneously once daily at bedtime'
          }
        ]
      });
      createdId = created.id;
    });

    test('fetches and parses created prescription by ID', async () => {
      const prescription = await getPrescriptionById(createdId);
      expect(prescription.id).toBe(createdId);
      expect(prescription.drugName).toContain('Insulin Glargine');
      expect(prescription.rxNormCode).toBe('313782');
      expect(prescription.patientRef).toBe('Patient/1');
    });

    test('GET /api/prescriptions/:id returns prescription details via Express', async () => {
      const res = await request(app).get(`/api/prescriptions/${createdId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdId);
      expect(res.body.data.rxNormCode).toBe('313782');
    });

    test('GET /api/prescriptions/:id returns 404 for non-existent prescription', async () => {
      const res = await request(app).get('/api/prescriptions/non-existent-99999');
      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

  });

});
