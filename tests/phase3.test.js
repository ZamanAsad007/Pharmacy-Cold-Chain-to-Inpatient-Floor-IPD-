const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/index');
const { parseOmpO09 } = require('../src/hl7v2/parser');

describe('Phase 3 — Parse Legacy HL7 v2 OMP^O09 Delivery Message', () => {

  const sampleFilePath = path.join(__dirname, '..', 'sample-data', 'hl7-omp-o09-sample.hl7');
  const sampleHl7 = fs.readFileSync(sampleFilePath, 'utf8');

  describe('Unit Tests — parseOmpO09', () => {

    test('correctly parses known sample OMP^O09 message using real HL7 parser', () => {
      const result = parseOmpO09(sampleHl7);

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect(result.data).toBeDefined();

      const { messageHeader, patient, order, medication } = result.data;

      // Header assertions
      expect(messageHeader.messageType).toBe('OMP^O09');
      expect(messageHeader.messageControlId).toBe('MSG10001');
      expect(messageHeader.sendingApp).toBe('PHARMACY');
      expect(messageHeader.sendingFacility).toBe('HOSPITAL');
      expect(messageHeader.receivingApp).toBe('FLOOR3');
      expect(messageHeader.timestamp).toBe('20260921090000');

      // Patient assertions
      expect(patient.patientId).toBe('PAT-98765');
      expect(patient.familyName).toBe('SMITH');
      expect(patient.givenName).toBe('JANE');
      expect(patient.birthDate).toBe('19850412');
      expect(patient.gender).toBe('F');

      // Order assertions
      expect(order.orderControl).toBe('NW');
      expect(order.placerOrderNumber).toBe('ORD-2026-001');
      expect(order.orderStatus).toBe('IP');

      // Medication assertions
      expect(medication.code).toBe('313782');
      expect(medication.name).toBe('Insulin Glargine 100 UNT/ML');
      expect(medication.codingSystem).toBe('RxNorm');
      expect(medication.giveAmount).toBe('10');
      expect(medication.giveUnits).toBe('UNT');
      expect(medication.specialHandling).toBe('REFRIGERATE');
      expect(medication.isColdChain).toBe(true);
    });

    test('detects cold-chain flag when handling specifies cold/chilled conditions', () => {
      const chilledHl7 = sampleHl7.replace('REFRIGERATE', 'STORE 2-8C COLD CHAIN');
      const result = parseOmpO09(chilledHl7);

      expect(result.success).toBe(true);
      expect(result.data.medication.isColdChain).toBe(true);
    });

    test('marks non-cold-chain medication properly', () => {
      const roomTempHl7 = sampleHl7.replace('REFRIGERATE', 'ROOM TEMPERATURE');
      const result = parseOmpO09(roomTempHl7);

      expect(result.success).toBe(true);
      expect(result.data.medication.isColdChain).toBe(false);
    });

  });

  describe('Edge Cases & Graceful Failure Handling', () => {

    test('fails gracefully when message has missing MSH header', () => {
      const malformed = 'PID|1||PAT-123||DOE^JOHN\nRXO|12345^Aspirin';
      const result = parseOmpO09(malformed);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing MSH segment header');
      expect(result.data).toBeNull();
    });

    test('fails gracefully on empty string input', () => {
      const result = parseOmpO09('');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty or invalid HL7 message');
    });

    test('fails gracefully on null or undefined input', () => {
      const result = parseOmpO09(null);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty or invalid HL7 message');
    });

    test('handles partially missing segments without crashing', () => {
      // Message with MSH and PID only (no ORC or RXO)
      const partialHl7 = 'MSH|^~\\&|PHARMACY|HOSPITAL|FLOOR3|HOSPITAL|20260921090000||OMP^O09|MSG10002|P|2.5\rPID|1||PAT-12345||DOE^JOHN';
      const result = parseOmpO09(partialHl7);

      expect(result.success).toBe(true);
      expect(result.data.messageHeader.messageControlId).toBe('MSG10002');
      expect(result.data.patient.patientId).toBe('PAT-12345');
      expect(result.data.order).toBeNull();
      expect(result.data.medication).toBeNull();
    });

  });

  describe('Express API Endpoint Tests', () => {

    test('POST /api/hl7/parse returns structured JSON for valid HL7 message', async () => {
      const res = await request(app)
        .post('/api/hl7/parse')
        .send({ message: sampleHl7 });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.messageHeader.messageType).toBe('OMP^O09');
      expect(res.body.data.medication.code).toBe('313782');
    });

    test('POST /api/hl7/parse returns 400 for malformed HL7 message', async () => {
      const res = await request(app)
        .post('/api/hl7/parse')
        .send({ message: 'INVALID HL7 DATA NOT STARTING WITH MSH' });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing MSH segment header');
    });

  });

});
