const request = require('supertest');
const app = require('../src/index');
const fs = require('fs');
const path = require('path');
const { checkFhirServer, fhirClient } = require('../src/fhir/client');

describe('Phase 0 — Environment & Setup Verification', () => {

  test('Verify project structure directories exist', () => {
    const requiredDirs = [
      'src/fhir',
      'src/rxnorm',
      'src/hl7v2',
      'src/notify',
      'src/audit',
      'tests',
      'sample-data'
    ];

    requiredDirs.forEach(dir => {
      const fullPath = path.join(__dirname, '..', dir);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  });

  test('Verify README.md exists', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
  });

  test('Express /health endpoint responds correctly', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.service).toBe('pharmacy-cold-chain');
    expect(res.body).toHaveProperty('fhirServer');
  });

});
