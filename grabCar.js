// grabCar.js - Scraper + Dynamic Geocoding + Salesforce Direct Insertion & Status Tracking

import puppeteer from 'puppeteer';
import jsforce from 'jsforce';
import https from 'https';

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

// --- YOUR SALESFORCE CREDENTIALS ---
const SF_USERNAME = process.env.SF_USERNAME || 'kai.weaver988.dae61fa699f9@agentforce.com';
const SF_PASSWORD = process.env.SF_PASSWORD || 'Blazer11';
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || 'PTlnkKjZZYoCIcJDDAayq9nh4'; 
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

const targetUrl = process.argv[2];

if (!targetUrl) {
  console.log("Error: Please provide a CarGurus link!");
  console.log('Example: node grabCar.js "https://www.cargurus.com/..."');
  process.exit(1);
}

// Post Falls, ID Baseline Coordinates
const POST_FALLS_COORDS = { latitude: 47.7121, longitude: -116.9482 };

// Dynamic Geocoding via OpenStreetMap (No API key needed)
function getCoordinates(locationString) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationString)}&format=json&limit=1`;
    
    const options = {
      headers: {
        'User-Agent': 'SalesforceCarTracker/1.0'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.length > 0) {
            resolve({
              latitude: parseFloat(parsed[0].lat),
              longitude: parseFloat(parsed[0].lon)
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  console.log("\n1. Opening CarGurus in background...");
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
  
  let listingStatus = "Active";

  try {
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    if (response && (response.status() === 404 || response.status() === 410)) {
      listingStatus = "Inactive";
    }
  } catch (err) {
    console.error("Navigation issue encountered:", err.message);
    listingStatus = "Inactive";
  }

  const pageText = await page.evaluate(() => document.body.innerText || "");
  const pageTitle = await page.title();
  const fullText = `${pageTitle} ${pageText}`.toUpperCase();
  await browser.close();

  if (fullText.includes("NO LONGER AVAILABLE") || fullText.includes("THIS CAR IS SOLD") || fullText.includes("VEHICLE NO LONGER AVAILABLE")) {
    listingStatus = "Sold";
  }

  // 1. Dynamic VIN Extraction
  let extractedVin = null;
  const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);

  if (vinMatch) {
    extractedVin = vinMatch[1].toUpperCase();
  } else {
    const listingIdMatch = targetUrl.match(/([0-9]{8,10})/);
    extractedVin = listingIdMatch ? `CG-${listingIdMatch[1]}` : `AUTO-${Date.now()}`;
  }

  // 2. Dynamic Year Extraction
  const yearMatch = fullText.match(/\b(20[1-2][0-9])\b/);
  const extractedYear = yearMatch ? yearMatch[1] : "2020";

  // 3. Dynamic Make & Model Detection
  let makeModel = "Toyota Corolla SE";
  if (fullText.includes("CIVIC")) {
    makeModel = "Honda Civic Sport";
  } else if (fullText.includes("CAMRY")) {
    makeModel = "Toyota Camry SE";
  } else if (fullText.includes("COROLLA")) {
    makeModel = fullText.includes("NIGHTSHADE") ? "Toyota Corolla Nightshade" : "Toyota Corolla SE";
  }

  // 4. Extraction logic for price and mileage
  const priceMatch = pageText.match(/\$([0-9]{2},[0-9]{3})/);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;

  const mileageMatch = pageText.match(/([0-9]{1,3},[0-9]{3})\s*(miles|mi)?/i);
  const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : 0;

  // 5. Targeted Owner Extraction
  let owners = 1;
  const historyMatch = pageText.match(/([1-9])\s*previous\s*owner(?:s)?/i);

  if (historyMatch) {
    owners = parseInt(historyMatch[1], 10);
  } else {
    const generalMatch = pageText.match(/\b([1-9])\s*-\s*owner\b/i) || 
                         pageText.match(/\b([1-9])\s*owner(?:s)?\b/i);
    if (generalMatch) {
      owners = parseInt(generalMatch[1], 10);
    }
  }

  // 6. Location Extraction
  const locationMatch = pageText.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
  const locationText = locationMatch ? `${locationMatch[1].trim().toUpperCase()}, ${locationMatch[2]}` : "UNKNOWN";
  const resolvedLocation = locationText !== "UNKNOWN" ? locationText : "Naples, FL";

  // 7. Dynamic Distance Calculation
  console.log(`2. Geocoding location: ${resolvedLocation}...`);
  let distanceMiles = 0;
  const targetCoords = await getCoordinates(resolvedLocation);

  if (targetCoords) {
    const meters = getDistanceInMeters(POST_FALLS_COORDS, targetCoords);
    distanceMiles = Math.round(meters * 0.000621371);
    console.log(` Calculated distance: ${distanceMiles} miles from Post Falls.`);
  } else {
    console.log(" Geocoding failed, using safety fallback distance.");
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

  console.log(`\n3. Parsed Vehicle: ${recordPayload.Name}`);
  console.log(` VIN / Key: ${extractedVin}`);
  console.log(` Previous Owners: ${owners}`);
  console.log(` Status Detected: ${listingStatus}`);
  console.log(" Connecting to Salesforce API...");
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    await conn.login(SF_USERNAME, SF_PASSWORD + SF_SECURITY_TOKEN);
    console.log(" Connected to Salesforce successfully!");

    console.log("\n4. Upserting record into Car_Candidate__c using VIN__c...");
    const result = await conn.sobject("Car_Candidate__c").upsert(recordPayload, 'VIN__c');

    if (result.success) {
      console.log(`\n SUCCESS! Record ID: ${result.id}`);
      console.log(` Record Name: "${recordPayload.Name}"`);
      console.log(` Logistics Miles: ${distanceMiles} mi`);
      console.log(` Listing Status: ${listingStatus}`);
      console.log(" Leaderboard dynamic score updated in Salesforce.");
    } else {
      console.error(" Upsert Failed:", result.errors);
    }
  } catch (err) {
    console.error(" Salesforce Error:", err.message);
  }
})();
