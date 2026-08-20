// grabCar.js - Multi-Filter Index Scraper & Salesforce Direct Insertion Pipeline

import puppeteer from 'puppeteer';
import jsforce from 'jsforce';
import https from 'https';
import fs from 'fs';

// Pure math Haversine calculation to replace external distance libs
function getDistanceInMeters(coord1, coord2) {
  const R = 6371000;
  const dLat = (coord2.latitude - coord1.latitude) * Math.PI / 180;
  const dLon = (coord2.longitude - coord1.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(coord1.latitude * Math.PI / 180) * Math.cos(coord2.latitude * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- SALESFORCE CREDENTIALS ---
const SF_USERNAME = process.env.SF_USERNAME || 'kai.weaver988.dae61fa699f9@agentforce.com';
const SF_PASSWORD = process.env.SF_PASSWORD || 'Blazer11';
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || 'PTlnkKjZZYoCIcJDDAayq9nh4'; 
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

const POST_FALLS_COORDS = { latitude: 47.7121, longitude: -116.9482 };

// Dynamic Geocoding via OpenStreetMap
function getCoordinates(locationString) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationString)}&format=json&limit=1`;
    const options = { headers: { 'User-Agent': 'SalesforceCarTracker/1.0' } };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.length > 0) {
            resolve({ latitude: parseFloat(parsed[0].lat), longitude: parseFloat(parsed[0].lon) });
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  // 1. Load Filter Search URLs from urls.json or command line
  let searchUrls = [];
  if (process.argv[2]) {
    searchUrls = [process.argv[2]];
  } else if (fs.existsSync('./urls.json')) {
    const fileData = fs.readFileSync('./urls.json', 'utf8');
    searchUrls = JSON.parse(fileData);
  } else {
    console.error("Error: No search link provided and urls.json not found!");
    process.exit(1);
  }

  console.log(`Loaded ${searchUrls.length} search filter URL(s) from urls.json.`);

  // 2. Connect to Salesforce API
  console.log("Connecting to Salesforce API...");
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  try {
    await conn.login(SF_USERNAME, SF_PASSWORD + SF_SECURITY_TOKEN);
    console.log("Connected to Salesforce successfully!\n");
  } catch (err) {
    console.error("Salesforce Login Error:", err.message);
    process.exit(1);
  }

  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // 3. STAGE 1: Collect individual vehicle listing URLs from search result pages
  const extractedVehicleUrls = new Set();

  for (let i = 0; i < searchUrls.length; i++) {
    const filterUrl = searchUrls[i];
    console.log(`Scanning filter index [${i + 1}/${searchUrls.length}] for vehicle tiles...`);

    const indexPage = await browser.newPage();
    await indexPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

    try {
      await indexPage.goto(filterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // Collect all vehicle detail page links (VDPs) from tiles
      const pageLinks = await indexPage.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors
          .map(a => a.href)
          .filter(href => href.includes('/vdp.action') || href.includes('/listing/'));
      });

      pageLinks.forEach(link => extractedVehicleUrls.add(link));
    } catch (err) {
      console.error(`Error scanning search index [${i + 1}]:`, err.message);
    }
    await indexPage.close();
  }

  const vehicleList = Array.from(extractedVehicleUrls);
  console.log(`\nFound ${vehicleList.length} unique vehicle detail listings across all search filters.\n`);

  // Fallback: If no tile links were extracted, process the targets directly
  const targetsToProcess = vehicleList.length > 0 ? vehicleList : searchUrls;

  // 4. STAGE 2: Scrape each vehicle detail page and upsert into Salesforce
  for (let i = 0; i < targetsToProcess.length; i++) {
    const targetUrl = targetsToProcess[i];
    console.log(`--- [${i + 1}/${targetsToProcess.length}] Scraping Detail Page: ${targetUrl} ---`);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
    
    let listingStatus = "Active";
    try {
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (response && (response.status() === 404 || response.status() === 410)) {
        listingStatus = "Inactive";
      }
    } catch (err) {
      console.error("Navigation issue:", err.message);
      listingStatus = "Inactive";
    }

    const pageText = await page.evaluate(() => document.body.innerText || "");
    const pageTitle = await page.title();
    const fullText = `${pageTitle} ${pageText}`.toUpperCase();
    await page.close();

    if (fullText.includes("NO LONGER AVAILABLE") || fullText.includes("THIS CAR IS SOLD") || fullText.includes("VEHICLE NO LONGER AVAILABLE")) {
      listingStatus = "Sold";
    }

    // Dynamic VIN Extraction (strictly enforcing 17-char maximum for Salesforce VIN__c)
    let extractedVin = null;
    const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);

    if (vinMatch) {
      extractedVin = vinMatch[1].toUpperCase();
    } else {
      const listingIdMatch = targetUrl.match(/([0-9]{8,10})/);
      if (listingIdMatch) {
        extractedVin = `CG-${listingIdMatch[1]}`.substring(0, 17);
      } else {
        extractedVin = `A${Date.now()}${Math.floor(Math.random() * 1000)}`.substring(0, 17);
      }
    }

    // Dynamic Year Extraction
    const yearMatch = fullText.match(/\b(20[1-2][0-9])\b/);
    const extractedYear = yearMatch ? yearMatch[1] : "2020";

    // Make & Model Detection
    let makeModel = "Toyota Corolla SE";
    if (fullText.includes("CIVIC")) {
      makeModel = "Honda Civic Sport";
    } else if (fullText.includes("CAMRY")) {
      makeModel = "Toyota Camry SE";
    } else if (fullText.includes("COROLLA")) {
      makeModel = fullText.includes("NIGHTSHADE") ? "Toyota Corolla Nightshade" : "Toyota Corolla SE";
    }

    // Price and Mileage Extraction
    const priceMatch = pageText.match(/\$([0-9]{2},[0-9]{3})/);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;

    const mileageMatch = pageText.match(/([0-9]{1,3},[0-9]{3})\s*(miles|mi)?/i);
    const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : 0;

    // Previous Owners Extraction
    let owners = 1;
    const historyMatch = pageText.match(/([1-9])\s*previous\s*owner(?:s)?/i);
    if (historyMatch) {
      owners = parseInt(historyMatch[1], 10);
    } else {
      const generalMatch = pageText.match(/\b([1-9])\s*-\s*owner\b/i) || pageText.match(/\b([1-9])\s*owner(?:s)?\b/i);
      if (generalMatch) owners = parseInt(generalMatch[1], 10);
    }

    // Location & Geocoded Distance
    const locationMatch = pageText.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
    const locationText = locationMatch ? `${locationMatch[1].trim().toUpperCase()}, ${locationMatch[2]}` : "UNKNOWN";
    const resolvedLocation = locationText !== "UNKNOWN" ? locationText : "Naples, FL";

    let distanceMiles = 0;
    const targetCoords = await getCoordinates(resolvedLocation);
    if (targetCoords) {
      const meters = getDistanceInMeters(POST_FALLS_COORDS, targetCoords);
      distanceMiles = Math.round(meters * 0.000621371);
    } else {
      distanceMiles = resolvedLocation.includes("FL") ? 2500 : 300; 
    }

    const recordPayload = {
      "Name": `${extractedYear} ${makeModel} - ${resolvedLocation}`,
      "Car_Price__c": price,
      "Mileage__c": mileage,
      "Previous_Owners__c": owners,
      "Make_and_Model__c": makeModel,
      "Year__c": extractedYear,
      "Location__c": resolvedLocation,
      "Logistics__c": distanceMiles,
      "VIN__c": extractedVin,
      "Status__c": listingStatus
    };

    console.log(`Upserting: ${recordPayload.Name} | VIN: ${extractedVin} | Status: ${listingStatus}`);

    try {
      const result = await conn.sobject("Car_Candidate__c").upsert(recordPayload, 'VIN__c');
      if (result.success) {
        console.log(`Successfully upserted record ID: ${result.id}\n`);
      } else {
        console.error("Upsert Failed:", result.errors, "\n");
      }
    } catch (err) {
      console.error("Salesforce Error:", err.message, "\n");
    }
  }

  await browser.close();
  console.log("Full batch extraction complete!");
})();
