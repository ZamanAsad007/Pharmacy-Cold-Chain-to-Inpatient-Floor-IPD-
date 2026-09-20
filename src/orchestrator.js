/**
 * Phase 7 — End-to-End Pharmacy Cold Chain Pipeline Orchestrator
 * 
 * Orchestrates the full lifecycle:
 *   Nurse Indent -> Fetch Prescription -> RxNorm Validation -> Legacy HL7 Message Parse ->
 *   Write MedicationDispense -> Strip PHI -> Send Nurse Alert -> Tamper-Evident Audit Logging
 */

const { getPrescriptionById } = require('./fhir/medicationRequest');
const { validatePrescription } = require('./rxnorm/validator');
const { parseOmpO09 } = require('./hl7v2/parser');
const { recordDispenseAndDispatch } = require('./fhir/medicationDispense');
const {
  sanitizeForNurseNotification,
  sendNurseNotification,
  verifyZeroPhi
} = require('./notify/sanitizer');
const { withAudit, logAuditEvent } = require('./audit/logger');

class PipelineError extends Error {
  constructor(message, stage, details = {}) {
    super(message);
    this.name = 'PipelineError';
    this.stage = stage;
    this.details = details;
  }
}

/**
 * Execute the end-to-end pharmacy cold chain workflow
 * @param {Object} options
 * @param {string} options.prescriptionId - MedicationRequest resource ID
 * @param {string} [options.hl7Message] - Optional raw HL7 v2 OMP^O09 message for cross-checking
 * @param {string|Object} [options.packer='Pharmacist Alex Chen'] - Dispense packager
 * @param {string|Object} [options.courier='Courier Maria Rodriguez'] - Cold-chain courier
 * @param {string} [options.eta] - Expected arrival timestamp (ISO string)
 * @param {string} [options.destinationStation='Floor 3 Inpatient Nursing Station'] - Destination ward
 * @param {string} [options.storageCondition='Maintain 2-8°C (Cold Chain)'] - Storage notes
 * @returns {Promise<Object>} Execution report detailing every pipeline stage
 */
async function runColdChainPipeline(options = {}) {
  const {
    prescriptionId,
    hl7Message,
    packer = 'Pharmacist Alex Chen',
    courier = 'Courier Maria Rodriguez',
    eta = new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    destinationStation = 'Floor 3 Inpatient Nursing Station',
    storageCondition = 'Maintain 2-8°C (Cold Chain)'
  } = options;

  const pipelineId = `PIPE-${Date.now()}`;
  const stageResults = {};

  try {
    if (!prescriptionId) {
      throw new PipelineError('Prescription ID is required to start cold-chain pipeline', 'input-validation');
    }

    // -------------------------------------------------------------------------
    // Stage 1: Read the Prescription (MedicationRequest)
    // -------------------------------------------------------------------------
    const prescription = await withAudit('read-prescription', async () => {
      return getPrescriptionById(prescriptionId);
    }, {
      action: 'R',
      entityRef: `MedicationRequest/${prescriptionId}`,
      successDesc: `Retrieved prescription ${prescriptionId} for cold-chain review`
    });

    stageResults.prescription = {
      id: prescription.id,
      drugName: prescription.drugName,
      rxNormCode: prescription.rxNormCode,
      dosage: prescription.dosage,
      patientRef: prescription.patientRef
    };

    // -------------------------------------------------------------------------
    // Stage 2: Validate Drug against NLM RxNorm / RxNav
    // -------------------------------------------------------------------------
    const drugValidation = await withAudit('validate-drug-identity', async () => {
      const validation = await validatePrescription(prescription);
      if (!validation.valid) {
        throw new PipelineError(validation.reason || 'Drug validation failed against RxNorm', 'validate-drug-identity', validation);
      }
      return validation;
    }, {
      action: 'E',
      entityRef: `MedicationRequest/${prescriptionId}`,
      successDesc: `Confirmed valid RxNorm identity (${prescription.rxNormCode}) for ${prescription.drugName}`
    });

    stageResults.drugValidation = {
      valid: true,
      rxNormCode: drugValidation.rxNormCode,
      matchedName: drugValidation.details?.name || prescription.drugName
    };

    // -------------------------------------------------------------------------
    // Stage 3: Parse Legacy HL7 v2 Delivery Message (if provided)
    // -------------------------------------------------------------------------
    if (hl7Message) {
      const hl7Result = parseOmpO09(hl7Message);
      if (!hl7Result.success) {
        throw new PipelineError(`Legacy HL7 message parse error: ${hl7Result.error}`, 'hl7-parsing');
      }

      stageResults.hl7 = {
        messageControlId: hl7Result.data.messageHeader?.messageControlId,
        messageType: hl7Result.data.messageHeader?.messageType,
        isColdChain: hl7Result.data.medication?.isColdChain ?? true,
        specialHandling: hl7Result.data.medication?.specialHandling
      };
    }

    // -------------------------------------------------------------------------
    // Stage 4: Write MedicationDispense Record & Confirm via Read-back
    // -------------------------------------------------------------------------
    const dispense = await withAudit('write-dispense-record', async () => {
      return recordDispenseAndDispatch({
        prescriptionId: prescription.id,
        patientRef: prescription.patientRef,
        drugName: prescription.drugName,
        rxNormCode: prescription.rxNormCode,
        packer,
        courier,
        eta,
        note: storageCondition
      });
    }, {
      action: 'C',
      getEntityRef: (r) => `MedicationDispense/${r.id}`,
      successDesc: `Dispatched cold-chain package with courier ${typeof courier === 'object' ? courier.name : courier}`
    });

    stageResults.dispense = {
      id: dispense.id,
      status: dispense.status,
      authorizingPrescription: dispense.authorizingPrescription,
      courier: dispense.courier,
      eta: dispense.eta
    };

    // -------------------------------------------------------------------------
    // Stage 5: Strip PHI & Build Safe Nurse Notification
    // -------------------------------------------------------------------------
    const notification = await withAudit('send-nurse-alert', async () => {
      const sanitizedPayload = sanitizeForNurseNotification(dispense, {
        destinationStation,
        storageCondition
      });

      // Assert zero PHI before network dispatch
      verifyZeroPhi(sanitizedPayload);

      const receipt = await sendNurseNotification(sanitizedPayload, {
        channel: 'Inpatient Floor Alert Gateway'
      });

      return { receipt, sanitizedPayload };
    }, {
      action: 'E',
      entityRef: `MedicationDispense/${dispense.id}`,
      successDesc: `Pushed de-identified delivery alert to ${destinationStation}`
    });

    stageResults.notification = {
      receiptId: notification.receipt.receiptId,
      destinationStation: notification.sanitizedPayload.destinationStation,
      estimatedArrival: notification.sanitizedPayload.estimatedArrival,
      storageCondition: notification.sanitizedPayload.storageCondition,
      sanitizedPayload: notification.sanitizedPayload
    };

    // -------------------------------------------------------------------------
    // Completed Pipeline Response
    // -------------------------------------------------------------------------
    return {
      success: true,
      pipelineId,
      completedAt: new Date().toISOString(),
      summary: `Successfully processed cold-chain indent for prescription ${prescriptionId}. Dispense ${dispense.id} en route to ${destinationStation}.`,
      stages: stageResults
    };

  } catch (error) {
    const failedStage = error.stage || 'unknown-stage';

    // Tamper-evident failure audit logging
    await logAuditEvent({
      action: 'E',
      subtype: 'pipeline-execution-failure',
      outcome: '4',
      outcomeDesc: `Pipeline failed at stage '${failedStage}': ${error.message}`,
      entity: `MedicationRequest/${prescriptionId}`
    }).catch(() => {});

    return {
      success: false,
      pipelineId,
      failedAt: new Date().toISOString(),
      failedStage,
      error: error.message,
      partialStages: stageResults
    };
  }
}

module.exports = {
  PipelineError,
  runColdChainPipeline
};
