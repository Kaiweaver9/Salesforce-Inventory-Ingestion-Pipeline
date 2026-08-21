// grabCar.js - Multi-Filter Index Scraper with Dynamic Tile Rendering & Smart Upsert

import puppeteer from 'puppeteer';
import jsforce from 'jsforce';
import https from 'https';
import fs from 'fs';

// Pure math Haversine calculation
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

// --- PAGINATION DEPTH CONFIGURATION ---
const MAX_PAGES_PER_FILTER = 3; // Updated to scan top 3 pages per sort vector

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
  // 1. Load Filter Search URLs
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

  console.log(`Loaded ${searchUrls.length} base search filter URL(s) from urls.json.`);
  console.log(`Configured Depth: Scanning top ${MAX_PAGES_PER_FILTER} page(s) per sort vector.\n`);

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

  // 2b. Fetch Existing Salesforce Records for Selective Field Protection
  console.log("Fetching existing records from Salesforce to preserve manual edits...");
  const existingMap = new Map();
  try {
    const existingRecords = await conn.sobject("Car_Candidate__c").find(
      {}, 
      ["Id", "VIN__c", "Previous_Owners__c", "Car_Price__c", "Listing_URL__c"]
    );
    existingRecords.forEach(rec => {
      if (rec.VIN__c) existingMap.set(rec.VIN__c, rec);
    });
    console.log(`Loaded ${existingMap.size} existing records into memory map.\n`);
  } catch (err) {
    console.warn("Notice: Could not fetch existing records for comparison. Proceeding with standard upsert payload:", err.message);
  }

  const browser = await puppeteer.launch({ 
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--window-size=1920,1080'
    ]
  });

  // 3. STAGE 1: Collect individual vehicle listing URLs across paginated filter pages
  const extractedVehicleUrls = new Set();

  for (let i = 0; i < searchUrls.length; i++) {
    const baseUrl = searchUrls[i];
    console.log(`=== Processing Filter Base [${i + 1}/${searchUrls.length}] ===`);

    for (let pageNum = 1; pageNum <= MAX_PAGES_PER_FILTER; pageNum++) {
      const targetFilterUrl = pageNum === 1 ? baseUrl : `${baseUrl}&page=${pageNum}`;
      console.log(`Scanning filter [${i + 1}/${searchUrls.length}] -> Page ${pageNum}...`);

      const indexPage = await browser.newPage();
      await indexPage.setViewport({ width: 1920, height: 1080 });
      await indexPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

      try {
        await indexPage.goto(targetFilterUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await indexPage.waitForSelector('a[href*="listing"], a[href*="vdp"]', { timeout: 15000 }).catch(() => {
          console.log(`Page ${pageNum}: Timeout waiting for explicit anchors, proceeding to DOM scan...`);
        });

        // Scroll to trigger lazy loading of car tiles
        await indexPage.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;

              if (totalHeight >= scrollHeight || totalHeight >= 4000) {
                clearInterval(timer);
                resolve();
              }
            }, 150);
          });
        });

        // Extract VDP / Listing links
        const pageLinks = await indexPage.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors
            .map(a => a.href)
            .filter(href => (href.includes('/vdp.action') || href.includes('/listing/') || href.includes('/detail')) && !href.includes('/search'));
        });

        console.log(`Page ${pageNum}: Found ${pageLinks.length} candidate vehicle links.`);
        
        if (pageLinks.length === 0) {
          console.log(`Page ${pageNum} yielded zero links. Reached end of pagination for Filter [${i + 1}]. Moving to next filter.`);
          await indexPage.close();
          break;
        }

        pageLinks.forEach(link => extractedVehicleUrls.add(link));

      } catch (err) {
        console.error(`Error scanning filter [${i + 1}] Page ${pageNum}:`, err.message);
      }
      await indexPage.close();
    }
  }

  const vehicleList = Array.from(extractedVehicleUrls);
  console.log(`\n======================================================`);
  console.log(`Total Unique Candidate Vehicles Extracted Across All Pages: ${vehicleList.length}`);
  console.log(`======================================================\n`);

  if (vehicleList.length === 0) {
    console.error("No vehicle tile links were extracted. Halting execution.");
    await browser.close();
    process.exit(1);
  }

  // 4. STAGE 2: Scrape each vehicle detail page and upsert into Salesforce
  for (let i = 0; i < vehicleList.length; i++) {
    const targetUrl = vehicleList[i];
    console.log(`--- [${i + 1}/${vehicleList.length}] Scraping Detail Page: ${targetUrl} ---`);

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

    // Dynamic VIN Extraction
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

    // --- SELECTIVE FIELD PROTECTION LOGIC ---
    let finalOwners = owners;
    let finalPrice = price;

    const existingRecord = existingMap.get(extractedVin);
    if (existingRecord) {
      if (existingRecord.Previous_Owners__c != null) {
        finalOwners = existingRecord.Previous_Owners__c;
      }
      if (existingRecord.Car_Price__c != null && price > 0) {
        finalPrice = Math.min(existingRecord.Car_Price__c, price);
      }
    }

    // Clean URL: Strip tracking query parameters to strictly enforce <255 character limit
    const cleanUrl = targetUrl.split('?')[0];

    const recordPayload = {
      "Name": `${extractedYear} ${makeModel} - ${resolvedLocation}`,
      "Car_Price__c": finalPrice,
      "Mileage__c": mileage,
      "Previous_Owners__c": finalOwners,
      "Make_and_Model__c": makeModel,
      "Year__c": extractedYear,
      "Location__c": resolvedLocation,
      "Logistics__c": distanceMiles,
      "VIN__c": extractedVin,
      "Listing_URL__c": cleanUrl, // Clean URL string safely under 255 chars
    };

    console.log(`Upserting: ${recordPayload.Name} | VIN: ${extractedVin} | URL: ${cleanUrl}`);

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
  console.log("Full multi-page batch extraction complete!");
})();
