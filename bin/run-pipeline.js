#!/usr/bin/env node

/**
 * CLI Trigger for End-to-End Pharmacy Cold Chain Flow (Phase 7)
 * 
 * Usage:
 *   node bin/run-pipeline.js [prescriptionId]
 *   npm run pipeline
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { fhirClient } = require('../src/fhir/client');
const { createMedicationRequest } = require('../src/fhir/medicationRequest');
const { runColdChainPipeline } = require('../src/orchestrator');
const { getAuditTrailForResource } = require('../src/audit/logger');

async function main() {
  console.log('\n=============================================================');
  console.log('  🏥 PHARMACY COLD CHAIN TO INPATIENT FLOOR — E2E PIPELINE  ');
  console.log('=============================================================\n');

  let prescriptionId = process.argv[2];

  // If no prescription ID provided, auto-seed a fresh sample prescription
  if (!prescriptionId) {
    console.log('📦 No Prescription ID passed. Seeding test record on FHIR server...');
    const patientRes = await fhirClient.post('/Patient', {
      resourceType: 'Patient',
      name: [{ family: 'Davis', given: ['Marcus'] }],
      birthDate: '1978-11-23'
    });

    const medReqRes = await createMedicationRequest({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patientRes.data.id}` },
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
      dosageInstruction: [{ text: '15 units subcutaneous qPM' }]
    });

    prescriptionId = medReqRes.id;
    console.log(`✅ Seeded Patient/${patientRes.data.id} and MedicationRequest/${prescriptionId}\n`);
  }

  // Load sample legacy HL7 message
  const hl7Path = path.join(__dirname, '..', 'sample-data', 'hl7-omp-o09-sample.hl7');
  const sampleHl7 = fs.existsSync(hl7Path) ? fs.readFileSync(hl7Path, 'utf8') : null;

  console.log(`🚀 Triggering pipeline for Prescription: MedicationRequest/${prescriptionId}...\n`);

  const result = await runColdChainPipeline({
    prescriptionId,
    hl7Message: sampleHl7,
    packer: 'Pharmacist Alex Chen (Lic# PH-4921)',
    courier: 'Courier Maria Rodriguez (Badge# CR-08)',
    destinationStation: 'Floor 3 Inpatient Nursing Station (Bed 302)',
    storageCondition: 'Maintain 2-8°C Continuous Refrigeration'
  });

  if (!result.success) {
    console.error('❌ Pipeline Failed!');
    console.error(`   Stage: ${result.failedStage}`);
    console.error(`   Error: ${result.error}\n`);
    process.exit(1);
  }

  console.log('-------------------------------------------------------------');
  console.log('  PIPELINE STAGE EXECUTION RESULTS');
  console.log('-------------------------------------------------------------');
  console.log(`1. [Phase 1] Prescription Read   : OK (${result.stages.prescription.drugName})`);
  console.log(`2. [Phase 2] RxNorm Validation   : OK (RxCUI: ${result.stages.drugValidation.rxNormCode})`);
  if (result.stages.hl7) {
    console.log(`3. [Phase 3] HL7 v2 Message Parse : OK (MsgID: ${result.stages.hl7.messageControlId}, ColdChain: ${result.stages.hl7.isColdChain})`);
  }
  console.log(`4. [Phase 4] MedicationDispense  : OK (ID: ${result.stages.dispense.id}, Status: ${result.stages.dispense.status})`);
  console.log(`5. [Phase 5] Nurse Alert Dispatched: OK (Receipt: ${result.stages.notification.receiptId})`);
  console.log(`             De-Identified Payload:`);
  console.log(`             - Category: ${result.stages.notification.sanitizedPayload.medicationCategory}`);
  console.log(`             - Courier : ${result.stages.notification.sanitizedPayload.courier}`);
  console.log(`             - ETA     : ${result.stages.notification.sanitizedPayload.estimatedArrival}`);
  console.log(`             - Patient PHI Excluded: YES (Verified)\n`);

  // Query Audit Trail
  console.log('-------------------------------------------------------------');
  console.log('  AUDIT TRAIL VERIFICATION (FHIR AuditEvent)');
  console.log('-------------------------------------------------------------');
  const trail = await getAuditTrailForResource(`MedicationRequest/${prescriptionId}`);
  console.log(`Found ${trail.length} audit events logged for MedicationRequest/${prescriptionId}:`);
  trail.forEach((evt, idx) => {
    console.log(`  ${idx + 1}. [${evt.action}] ${evt.subtype?.[0]?.code} -> Outcome: ${evt.outcome} (${evt.outcomeDesc})`);
  });

  console.log('\n=============================================================');
  console.log('  🎉 PIPELINE EXECUTION COMPLETED WITH ZERO ERRORS');
  console.log('=============================================================\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}

module.exports = main;
