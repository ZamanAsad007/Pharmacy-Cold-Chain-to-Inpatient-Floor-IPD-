const request = require('supertest');
const app = require('../src/index');
const { fhirClient } = require('../src/fhir/client');
const {
  ETA_EXTENSION_URL,
  DISPENSE_PERFORMER_SYSTEM,
  buildMedicationDispense,
  createMedicationDispense,
  fetchMedicationDispense,
  parseMedicationDispense,
  getDispenseById,
  recordDispenseAndDispatch
} = require('../src/fhir/medicationDispense');
const { createMedicationRequest } = require('../src/fhir/medicationRequest');

describe('Phase 4 — Write the Dispense Record Back to the Server (MedicationDispense)', () => {

  const mockOptions = {
    prescriptionId: 'med-req-501',
    patientRef: 'Patient/101',
    drugName: 'Insulin Glargine 100 UNT/ML Injectable Solution',
    rxNormCode: '313782',
    packer: {
      name: 'Pharmacist Alex Chen',
      reference: 'Practitioner/pharm-01'
    },
    courier: {
      name: 'Courier Maria Rodriguez',
      reference: 'Practitioner/courier-01'
    },
    eta: '2026-09-21T10:30:00.000Z',
    whenPrepared: '2026-09-21T09:15:00.000Z',
    whenHandedOver: '2026-09-21T09:20:00.000Z',
    note: 'Temperature-monitored cold chain dispatch (2-8°C)'
  };

  describe('Unit Tests — buildMedicationDispense', () => {

    test('constructs valid FHIR R4 MedicationDispense resource with all required fields', () => {
      const resource = buildMedicationDispense(mockOptions);

      expect(resource.resourceType).toBe('MedicationDispense');
      expect(resource.status).toBe('in-progress');
      expect(resource.subject.reference).toBe('Patient/101');
      expect(resource.authorizingPrescription[0].reference).toBe('MedicationRequest/med-req-501');

      // Drug details
      expect(resource.medicationCodeableConcept.text).toBe(mockOptions.drugName);
      expect(resource.medicationCodeableConcept.coding[0].code).toBe('313782');
      expect(resource.medicationCodeableConcept.coding[0].system).toBe('http://www.nlm.nih.gov/research/umls/rxnorm');

      // Performers
      expect(resource.performer).toHaveLength(2);
      const packer = resource.performer.find(p => p.function.coding[0].code === 'packager');
      expect(packer).toBeDefined();
      expect(packer.actor.display).toBe('Pharmacist Alex Chen');
      expect(packer.actor.reference).toBe('Practitioner/pharm-01');

      const courier = resource.performer.find(p => p.function.coding[0].code === 'courier');
      expect(courier).toBeDefined();
      expect(courier.actor.display).toBe('Courier Maria Rodriguez');
      expect(courier.actor.reference).toBe('Practitioner/courier-01');

      // Timestamps & ETA
      expect(resource.whenPrepared).toBe('2026-09-21T09:15:00.000Z');
      expect(resource.whenHandedOver).toBe('2026-09-21T09:20:00.000Z');
      expect(resource.extension[0].url).toBe(ETA_EXTENSION_URL);
      expect(resource.extension[0].valueDateTime).toBe('2026-09-21T10:30:00.000Z');

      // Notes
      expect(resource.note[0].text).toBe('Temperature-monitored cold chain dispatch (2-8°C)');
    });

    test('accepts string packer and courier representations', () => {
      const resource = buildMedicationDispense({
        ...mockOptions,
        packer: 'Pharmacist Dave',
        courier: 'Courier Sarah'
      });

      const packer = resource.performer.find(p => p.function.coding[0].code === 'packager');
      expect(packer.actor.display).toBe('Pharmacist Dave');

      const courier = resource.performer.find(p => p.function.coding[0].code === 'courier');
      expect(courier.actor.display).toBe('Courier Sarah');
    });

    test('validates required fields and throws descriptive errors', () => {
      expect(() => buildMedicationDispense({ ...mockOptions, prescriptionId: null, medicationRequestId: null }))
        .toThrow('Prescription reference (medicationRequestId or prescriptionId) is required');

      expect(() => buildMedicationDispense({ ...mockOptions, patientRef: null, subject: null }))
        .toThrow('Patient reference (patientRef) is required');

      expect(() => buildMedicationDispense({ ...mockOptions, packer: null }))
        .toThrow('Packer information (packer) is required');

      expect(() => buildMedicationDispense({ ...mockOptions, courier: null }))
        .toThrow('Courier information (courier) is required');

      expect(() => buildMedicationDispense({ ...mockOptions, eta: null }))
        .toThrow('Expected arrival time (eta) is required');
    });

  });

  describe('Unit Tests — parseMedicationDispense', () => {

    test('correctly extracts structured fields from raw MedicationDispense', () => {
      const rawResource = buildMedicationDispense(mockOptions);
      rawResource.id = 'dispense-999';

      const parsed = parseMedicationDispense(rawResource);

      expect(parsed.id).toBe('dispense-999');
      expect(parsed.status).toBe('in-progress');
      expect(parsed.patientRef).toBe('Patient/101');
      expect(parsed.authorizingPrescription).toBe('MedicationRequest/med-req-501');
      expect(parsed.drugName).toBe(mockOptions.drugName);
      expect(parsed.rxNormCode).toBe('313782');
      expect(parsed.packer.name).toBe('Pharmacist Alex Chen');
      expect(parsed.courier.name).toBe('Courier Maria Rodriguez');
      expect(parsed.eta).toBe('2026-09-21T10:30:00.000Z');
      expect(parsed.notes).toContain('Temperature-monitored cold chain dispatch (2-8°C)');
    });

    test('throws error for non-MedicationDispense resource', () => {
      expect(() => parseMedicationDispense({ resourceType: 'MedicationRequest' }))
        .toThrow('Invalid resource type. Expected MedicationDispense.');
    });

    test('gracefully handles missing optional fields in raw resource', () => {
      const minimalRaw = {
        resourceType: 'MedicationDispense',
        id: 'min-dispense-1',
        status: 'in-progress'
      };

      const parsed = parseMedicationDispense(minimalRaw);
      expect(parsed.id).toBe('min-dispense-1');
      expect(parsed.status).toBe('in-progress');
      expect(parsed.drugName).toBe('Unknown Drug');
      expect(parsed.rxNormCode).toBeNull();
      expect(parsed.packer).toBeNull();
      expect(parsed.courier).toBeNull();
      expect(parsed.eta).toBeNull();
      expect(parsed.notes).toEqual([]);
    });

  });

  describe('Integration Tests — FHIR Server Persistence & Read-Back Verification', () => {
    let testPatientId;
    let testPrescriptionId;
    let testPackerPractitionerId;
    let testCourierPractitionerId;
    let createdDispenseId;

    beforeAll(async () => {
      // Create prerequisite Patient resource
      const patientRes = await fhirClient.post('/Patient', {
        resourceType: 'Patient',
        name: [{ family: 'ColdChainTest', given: ['Jane'] }]
      });
      testPatientId = patientRes.data.id;

      // Create prerequisite Practitioner resources
      const packerRes = await fhirClient.post('/Practitioner', {
        resourceType: 'Practitioner',
        name: [{ family: 'Chen', given: ['Alex'], prefix: ['PharmD'] }]
      });
      testPackerPractitionerId = packerRes.data.id;

      const courierRes = await fhirClient.post('/Practitioner', {
        resourceType: 'Practitioner',
        name: [{ family: 'Rodriguez', given: ['Maria'] }]
      });
      testCourierPractitionerId = courierRes.data.id;

      // Create prerequisite MedicationRequest resource
      const medReqRes = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${testPatientId}` },
        medicationCodeableConcept: {
          coding: [{
            system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            code: '313782',
            display: 'Insulin Glargine 100 UNT/ML Injectable Solution'
          }],
          text: 'Insulin Glargine 100 UNT/ML Injectable Solution'
        }
      });
      testPrescriptionId = medReqRes.id;
    });

    test('creates MedicationDispense and confirms write by reading it back', async () => {
      const confirmedDispense = await recordDispenseAndDispatch({
        prescriptionId: testPrescriptionId,
        patientRef: `Patient/${testPatientId}`,
        drugName: 'Insulin Glargine 100 UNT/ML Injectable Solution',
        rxNormCode: '313782',
        packer: {
          name: 'Pharmacist Alex Chen',
          reference: `Practitioner/${testPackerPractitionerId}`
        },
        courier: {
          name: 'Courier Maria Rodriguez',
          reference: `Practitioner/${testCourierPractitionerId}`
        },
        eta: '2026-09-21T10:30:00.000Z',
        note: 'Store 2-8C cold chain'
      });

      expect(confirmedDispense).toBeDefined();
      expect(confirmedDispense.id).toBeDefined();
      createdDispenseId = confirmedDispense.id;

      expect(confirmedDispense.status).toBe('in-progress');
      expect(confirmedDispense.authorizingPrescription).toBe(`MedicationRequest/${testPrescriptionId}`);
      expect(confirmedDispense.patientRef).toBe(`Patient/${testPatientId}`);
      expect(confirmedDispense.drugName).toContain('Insulin Glargine');
      expect(confirmedDispense.rxNormCode).toBe('313782');
      expect(confirmedDispense.packer.name).toBe('Pharmacist Alex Chen');
      expect(confirmedDispense.courier.name).toBe('Courier Maria Rodriguez');
      expect(confirmedDispense.eta).toBe('2026-09-21T10:30:00.000Z');
      expect(confirmedDispense.notes).toContain('Store 2-8C cold chain');

      // Fetch independently from FHIR server to double-verify persistence
      const fetchedDirectly = await getDispenseById(createdDispenseId);
      expect(fetchedDirectly.id).toBe(createdDispenseId);
      expect(fetchedDirectly.status).toBe('in-progress');
      expect(fetchedDirectly.courier.name).toBe('Courier Maria Rodriguez');
    });

    test('handles server rejection gracefully when posting invalid resource', async () => {
      // Invalid resource: referencing non-existent prescription
      const invalidResource = {
        resourceType: 'MedicationDispense',
        status: 'in-progress',
        subject: { reference: `Patient/${testPatientId}` },
        authorizingPrescription: [{ reference: 'MedicationRequest/non-existent-999999' }],
        medicationCodeableConcept: { text: 'Unknown' }
      };

      await expect(createMedicationDispense(invalidResource))
        .rejects.toThrow(/Failed to create MedicationDispense/);
    });

    test('handles 404 for non-existent MedicationDispense ID', async () => {
      await expect(fetchMedicationDispense('non-existent-dispense-999999'))
        .rejects.toThrow("MedicationDispense with ID 'non-existent-dispense-999999' not found");
    });

  });

  describe('Integration Tests — Express API Endpoints', () => {
    let apiPatientId;
    let apiPrescriptionId;
    let apiDispenseId;

    beforeAll(async () => {
      // Create prerequisite Patient and MedicationRequest
      const pRes = await fhirClient.post('/Patient', {
        resourceType: 'Patient',
        name: [{ family: 'ExpressApiTest', given: ['John'] }]
      });
      apiPatientId = pRes.data.id;

      const mRes = await createMedicationRequest({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: `Patient/${apiPatientId}` },
        medicationCodeableConcept: { text: 'Amoxicillin 500mg' }
      });
      apiPrescriptionId = mRes.id;
    });

    test('POST /api/dispenses creates dispense record and returns confirmed 201 response', async () => {
      const res = await request(app)
        .post('/api/dispenses')
        .send({
          prescriptionId: apiPrescriptionId,
          patientRef: `Patient/${apiPatientId}`,
          drugName: 'Amoxicillin 500mg',
          packer: 'Pharmacist Dave',
          courier: 'Courier Steve',
          eta: '2026-09-21T11:00:00.000Z',
          note: 'Urgent delivery to floor 3'
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.packer.name).toBe('Pharmacist Dave');
      expect(res.body.data.courier.name).toBe('Courier Steve');
      expect(res.body.data.authorizingPrescription).toBe(`MedicationRequest/${apiPrescriptionId}`);

      apiDispenseId = res.body.data.id;
    });

    test('GET /api/dispenses/:id retrieves dispense record by ID', async () => {
      const res = await request(app).get(`/api/dispenses/${apiDispenseId}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(apiDispenseId);
      expect(res.body.data.courier.name).toBe('Courier Steve');
      expect(res.body.data.notes).toContain('Urgent delivery to floor 3');
    });

    test('GET /api/dispenses/:id returns 404 for non-existent ID', async () => {
      const res = await request(app).get('/api/dispenses/non-existent-dispense-99999');

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    test('POST /api/dispenses returns 400 for invalid/missing fields', async () => {
      const res = await request(app)
        .post('/api/dispenses')
        .send({
          prescriptionId: apiPrescriptionId
          // missing patientRef, packer, courier, eta
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('required');
    });

  });

});
