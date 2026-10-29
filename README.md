# Automated Car Scraper & Scoring Algorithm Pipeline

An end-to-end automated ETL pipeline and scoring engine that ingests, evaluates, and ranks pre-owned vehicle listings from CarGurus using headless browser automation, scheduled CI/CD workflows, and a custom Salesforce object architecture.

---

## 🚀 Leaderboard Preview

> *Live Salesforce List View: Automated Car Leaderboard running multi-variable scoring algorithms across regional inventory.*

<img width="1366" height="476" alt="Car Scraper Salesforce" src="https://github.com/user-attachments/assets/3f82583e-745e-420e-bf12-0ef41686fe98" />

---

## 🛠️ System Architecture & Tech Stack

* **Data Ingestion:** Node.js, Puppeteer (Headless Browser Automation)
* **Automation & CI/CD:** GitHub Actions (Cron-scheduled execution every 6 hours)
* **Backend & Storage:** Salesforce Custom Objects (`Car_Candidate__c`)
* **Scoring Engine:** Declarative Salesforce Formula Fields (`Total_Score__c`)
* **Data Integration:** REST API / Bulk Ingestion pipelines pushing payloads directly into the Salesforce org.

---

## ⚙️ Core Pipeline Workflow

1. **Automated Scraping (GitHub Actions):** 
   * A cron-scheduled GitHub Actions workflow triggers the Node.js/Puppeteer script every 6 hours.
   * The script executes headless browser extraction against CarGurus, harvesting active listings, pricing, mileage, location data, and direct vehicle URLs.
2. **Data Ingestion & Staging:**
   * Parsed JSON payloads are mapped and pushed directly into the Salesforce custom object schema (`Car_Candidate__c`).
3. **Algorithmic Evaluation (`Total_Score__c`):**
   * Instead of manual filtering, incoming records pass through a multi-variable custom formula score.
   * Evaluates variables including Total Cost of Acquisition (Purchase Price + Shipping/Logistics), mileage decay, model year, and previous owner penalties.
4. **Actionable Leaderboard:**
   * Records are dynamically sorted into a segmented Salesforce List View (**Car Leaderboard**), surfacing high-probability matches (scoring 75+ points) with calculated target discounts and direct inventory links.

---

## 🧮 Multi-Variable Scoring Engine Logic

The custom formula architecture computes a real-time score (`Total_Score__c`) using weighted criteria:
* **Mileage Baseline:** Evaluated against a localized wear curve (capped at a 40-point primary weight).
* **Ownership Decay:** Tiered deductions integrated directly into the schema (1 owner = 10 pts max, 2 owners = 8 pts, 3+ owners = 6 pts).
* **Logistics & Distance Decay:** Factoring transport friction and shipping distance into the net valuation equation.
* **Target Pricing Delta:** Automatically identifies required price corrections to clear the strict threshold required for asset acquisition.

---

## 📂 Repository Structure

```text
├── .github/
│ └── workflows/
│ └── scraper-cron.yml # 6-hour headless Puppeteer execution trigger
├── src/
│ ├── scraper.js # Node.js Puppeteer extraction engine
│ ├── transformer.js # Payload normalization & data cleaning
│ └── sfConnector.js # Salesforce REST API bulk ingestion
├── salesforce/
│ ├── objects/ # Car_Candidate__c custom object definitions
│ └── formulas/ # Total_Score__c & pricing algorithm logic
└── README.md
