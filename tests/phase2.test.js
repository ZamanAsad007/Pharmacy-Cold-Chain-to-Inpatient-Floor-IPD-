const request = require('supertest');
const app = require('../src/index');
const {
  rxNavClient,
  queryRxNormByName,
  getRxNormProperties,
  validateDrug,
  validatePrescription
} = require('../src/rxnorm/validator');

describe('Phase 2 — Validate the Drug Against RxNorm', () => {

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Unit Tests with Mocks (Offline Safe)', () => {

    test('valid drug returns match and details', async () => {
      // Mock /rxcui.json
      jest.spyOn(rxNavClient, 'get').mockImplementation((url, config) => {
        if (url === '/rxcui.json' && config?.params?.name === 'Amoxicillin') {
          return Promise.resolve({
            data: { idGroup: { rxnormId: ['723'] } }
          });
        }
        if (url === '/rxcui/723/properties.json') {
          return Promise.resolve({
            data: {
              properties: {
                rxcui: '723',
                name: 'amoxicillin',
                tty: 'IN'
              }
            }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await validateDrug('Amoxicillin');
      expect(result.valid).toBe(true);
      expect(result.rxNormCode).toBe('723');
      expect(result.drugName).toBe('Amoxicillin');
      expect(result.details.name).toBe('amoxicillin');
    });

    test('valid drug with matching expected RxNorm code passes', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url, config) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({
            data: { idGroup: { rxnormId: ['723'] } }
          });
        }
        if (url === '/rxcui/723/properties.json') {
          return Promise.resolve({
            data: {
              properties: { rxcui: '723', name: 'amoxicillin' }
            }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await validateDrug('Amoxicillin', '723');
      expect(result.valid).toBe(true);
      expect(result.rxNormCode).toBe('723');
    });

    test('valid drug with mismatched expected RxNorm code fails', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url, config) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({
            data: { idGroup: { rxnormId: ['723'] } }
          });
        }
        if (url === '/rxcui/99999/properties.json') {
          return Promise.resolve({
            data: { properties: null }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await validateDrug('Amoxicillin', '99999');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not match');
    });

    test('deliberately wrong/misspelled drug returns no match / fail', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({ data: { idGroup: {} } });
        }
        if (url === '/approximateTerm.json') {
          return Promise.resolve({ data: { approximateGroup: { candidate: [] } } });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await validateDrug('DeliberatelyWrongMedicationXYZ');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found in RxNorm database');
      expect(result.rxNormCode).toBeNull();
    });

    test('approximate match is used when direct match returns nothing', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url, config) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({ data: { idGroup: {} } });
        }
        if (url === '/approximateTerm.json') {
          return Promise.resolve({
            data: {
              approximateGroup: {
                candidate: [{ rxcui: '274783', score: '80', rank: '1' }]
              }
            }
          });
        }
        if (url === '/rxcui/274783/properties.json') {
          return Promise.resolve({
            data: { properties: { rxcui: '274783', name: 'Insulin Glargine' } }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await validateDrug('Insulin Glargine');
      expect(result.valid).toBe(true);
      expect(result.rxNormCode).toBe('274783');
    });

    test('validatePrescription extracts drugName and rxNormCode to validate', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({ data: { idGroup: { rxnormId: ['723'] } } });
        }
        if (url === '/rxcui/723/properties.json') {
          return Promise.resolve({
            data: { properties: { rxcui: '723', name: 'amoxicillin' } }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const samplePrescription = {
        id: 'rx-42',
        drugName: 'Amoxicillin',
        rxNormCode: '723'
      };

      const result = await validatePrescription(samplePrescription);
      expect(result.prescriptionId).toBe('rx-42');
      expect(result.valid).toBe(true);
      expect(result.rxNormCode).toBe('723');
    });

    test('handles API network failure gracefully', async () => {
      jest.spyOn(rxNavClient, 'get').mockRejectedValue(new Error('Network Timeout'));

      await expect(queryRxNormByName('Amoxicillin'))
        .rejects.toThrow('RxNav API query failed: Network Timeout');
    });

  });

  describe('Express API Endpoint Tests', () => {

    test('POST /api/validate-drug returns validation response', async () => {
      jest.spyOn(rxNavClient, 'get').mockImplementation((url) => {
        if (url === '/rxcui.json') {
          return Promise.resolve({ data: { idGroup: { rxnormId: ['723'] } } });
        }
        if (url === '/rxcui/723/properties.json') {
          return Promise.resolve({
            data: { properties: { rxcui: '723', name: 'amoxicillin' } }
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const res = await request(app)
        .post('/api/validate-drug')
        .send({ drugName: 'Amoxicillin', rxNormCode: '723' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.rxNormCode).toBe('723');
    });

  });

});
