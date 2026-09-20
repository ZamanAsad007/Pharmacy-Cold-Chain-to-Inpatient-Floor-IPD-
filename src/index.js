require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { checkFhirServer } = require('./fhir/client');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  const fhirHealth = await checkFhirServer();
  res.json({
    status: 'ok',
    service: 'pharmacy-cold-chain',
    fhirServer: fhirHealth
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Pharmacy Cold Chain service listening on port ${port}`);
  });
}

module.exports = app;
