require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { checkFhirServer } = require('./fhir/client');
const {
  getPrescriptionById,
  createMedicationRequest
} = require('./fhir/medicationRequest');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/health', async (req, res) => {
  const fhirHealth = await checkFhirServer();
  res.json({
    status: 'ok',
    service: 'pharmacy-cold-chain',
    fhirServer: fhirHealth
  });
});

// Phase 1: Fetch and parse prescription record
app.get('/api/prescriptions/:id', async (req, res) => {
  try {
    const prescription = await getPrescriptionById(req.params.id);
    res.json({
      success: true,
      data: prescription
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

// Create prescription endpoint (helper for testing/seeding)
app.post('/api/prescriptions', async (req, res) => {
  try {
    const createdResource = await createMedicationRequest(req.body);
    res.status(201).json({
      success: true,
      data: createdResource
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Pharmacy Cold Chain service listening on port ${port}`);
  });
}

module.exports = app;
