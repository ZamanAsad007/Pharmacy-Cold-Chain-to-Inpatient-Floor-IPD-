# Pharmacy Cold Chain to Inpatient Floor (IPD)

A standards-compliant, FHIR R4 & HL7-integrated healthcare interoperability solution for managing pharmacy cold chain medication distribution from the central pharmacy to inpatient floor nursing stations.

---

## Overview

This system provides a secure, standards-compliant pipeline for handling temperature-sensitive medication orders (such as biologics, vaccines, and insulins). It integrates FHIR R4 resources (`MedicationRequest`, `MedicationDispense`, `AuditEvent`), validates drug identities against the National Library of Medicine (NLM) RxNorm/RxNav API, parses legacy HL7 v2 messages (`OMP^O09`), strips Protected Health Information (PHI) under HIPAA Safe Harbor data minimization rules for nurse alerts, and logs tamper-evident audit trails.

---

## Features & Capabilities

- **FHIR R4 Server Integration**: Reads `MedicationRequest`, creates `MedicationDispense`, and queries live HAPI FHIR JPA servers.
- **RxNorm Drug Validation**: Verifies drug codes and formulations against the NLM RxNav API (eliminating naive string-matching anti-patterns).
- **Legacy HL7 v2 Parsing**: AST-based parser for `OMP^O09` pharmacy order messages with cold chain requirement detection.
- **MedicationDispense Logistics**: Captures packager, courier performer roles, and expected arrival times (ETA) via compliant FHIR extensions.
- **PHI Stripping & Data Minimization**: Sanitizes outbound push notifications to mobile devices, completely excluding patient identifiers while preserving essential logistics.
- **Tamper-Evident Audit Logging**: Generates permanent FHIR `AuditEvent` records for all reads, writes, alerts, and execution failures with full chronological trail reconstruction.
- **End-to-End Orchestrator**: Single trigger pipeline running the full clinical story from indent to nurse alert.
- **SMART on FHIR PKCE Login (Stretch)**: Implements OAuth 2.0 with RFC 7636 PKCE for EHR launch with zero cleartext tokens in `localStorage`.

---

## Directory Structure

```text
/
├── docker-compose.yml       # HAPI FHIR server container definition
├── package.json             # Scripts & dependencies
├── README.md                # Project setup & usage guide
├── DECISIONS.md             # Architectural decisions, trade-offs & gap log
├── implementation.md        # Phase-by-phase implementation plan
├── bin/
│   └── run-pipeline.js      # CLI command runner for end-to-end pipeline
├── src/
│   ├── index.js             # Express API entry point & route definitions
│   ├── orchestrator.js      # Phase 7 End-to-End pipeline orchestrator
│   ├── fhir/
│   │   ├── client.js        # Axios FHIR R4 client & connectivity checks
│   │   ├── medicationRequest.js   # Phase 1: Read & parse prescriptions
│   │   └── medicationDispense.js  # Phase 4: Construct, write & verify dispenses
│   ├── rxnorm/
│   │   └── validator.js     # Phase 2: NLM RxNav / RxNorm drug validation
│   ├── hl7v2/
│   │   └── parser.js        # Phase 3: AST-based OMP^O09 message parser
│   ├── notify/
│   │   └── sanitizer.js     # Phase 5: PHI stripper & nurse alert dispatcher
│   ├── audit/
│   │   └── logger.js        # Phase 6: FHIR AuditEvent generator & interceptor
│   └── auth/
│       └── smartAuth.js     # Phase 8: SMART on FHIR OAuth 2.0 PKCE auth
├── tests/                   # Automated Jest test suites (Phases 0–8)
│   ├── phase0.test.js
│   ├── phase1.test.js
│   ├── phase2.test.js
│   ├── phase3.test.js
│   ├── phase4.test.js
│   ├── phase5.test.js
│   ├── phase6.test.js
│   ├── phase7.test.js
│   └── phase8.test.js
└── sample-data/             # Standards-compliant sample test fixtures
    ├── patient-sample.json
    ├── medication-request-sample.json
    ├── medication-dispense-sample.json
    ├── audit-event-sample.json
    └── hl7-omp-o09-sample.hl7
```

---

## Prerequisites

- **Node.js**: v18.x or higher
- **npm**: v9.x or higher
- **Docker** or **Podman**: For running the local HAPI FHIR JPA server container

---

## Quick Start & Setup

### 1. Start Local FHIR Server

Run the official HAPI FHIR JPA Starter container:

```bash
docker run -d --name hapi-fhir -p 8088:8080 hapiproject/hapi:v6.10.0
```

Verify that the FHIR server is reachable:

```bash
curl http://localhost:8088/fhir/metadata
```

### 2. Install Project Dependencies

```bash
npm install
```

### 3. Environment Configuration

Copy `.env.example` to `.env` (or use defaults):

```env
PORT=3000
FHIR_BASE_URL=http://localhost:8088/fhir
RXNAV_BASE_URL=https://rxnav.nlm.nih.gov/REST
```

### 4. Run the Automated Test Suite

Run all automated unit and integration test suites:

```bash
npm test
```

*Expected output: All 9 test suites and 73+ tests pass.*

### 5. Run the End-to-End Pipeline (One-Command Demo)

Run the full end-to-end clinical workflow from the CLI:

```bash
npm run pipeline
```

Or pass a specific prescription ID:

```bash
node bin/run-pipeline.js [prescriptionId]
```

### 6. Start the Express API Service

```bash
npm start
```

The service will listen on `http://localhost:3000`.

---

## API Reference

| Method | Endpoint | Description | Phase |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Service and FHIR server health status | 0 |
| `GET` | `/api/prescriptions/:id` | Fetch and parse `MedicationRequest` | 1 |
| `POST` | `/api/prescriptions` | Seed a new prescription on FHIR server | 1 |
| `POST` | `/api/validate-drug` | Validate drug name against RxNorm/RxNav | 2 |
| `GET` | `/api/prescriptions/:id/validate` | Fetch prescription and validate its drug in one call | 2 |
| `POST` | `/api/hl7/parse` | Parse raw legacy HL7 v2 `OMP^O09` message | 3 |
| `POST` | `/api/dispenses` | Record `MedicationDispense` and verify read-back | 4 |
| `GET` | `/api/dispenses/:id` | Retrieve standardized dispense details by ID | 4 |
| `POST` | `/api/notify/nurse` | Strip PHI and dispatch nurse alert payload | 5 |
| `GET` | `/api/notify/history` | Retrieve nurse alert dispatch history | 5 |
| `GET` | `/api/audit` | Query FHIR `AuditEvent` records | 6 |
| `GET` | `/api/audit/trail/:resourceType/:id`| Reconstruct chronological audit history for a resource | 6 |
| `POST` | `/api/pipeline/run` | Trigger full end-to-end cold-chain pipeline | 7 |
| `GET` | `/api/auth/smart/launch` | Initiate SMART on FHIR PKCE EHR launch | 8 |
| `GET` | `/api/auth/smart/callback` | OAuth callback & PKCE code token exchange | 8 |
| `GET` | `/api/auth/smart/session/:id`| Retrieve authenticated session context | 8 |

---

## Architectural Decisions & Trade-Offs

Detailed design rationales, trade-offs, and gaps are documented in **[`DECISIONS.md`](./DECISIONS.md)**.

---

## Implementation Roadmap

- [x] **Phase 0**: Environment Setup (HAPI FHIR, folder structure, Express/dependencies)
- [x] **Phase 1**: Read Prescription (`MedicationRequest`)
- [x] **Phase 2**: Validate Drug via RxNorm API
- [x] **Phase 3**: Parse HL7 v2 `OMP^O09` Message
- [x] **Phase 4**: Write `MedicationDispense` to FHIR Server
- [x] **Phase 5**: PHI Stripping & Nurse Notification Payload
- [x] **Phase 6**: AuditEvent Logging
- [x] **Phase 7**: End-to-End Flow Integration
- [x] **Phase 8**: SMART on FHIR PKCE Login (Stretch)
- [x] **Phase 9**: Final Documentation & Verification
