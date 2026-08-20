// grabCar.js - Fully Patched Precision Extractor & Salesforce Sync

import puppeteer from 'puppeteer';
import jsforce from 'jsforce';
import fs from 'fs';

// --- YOUR SALESFORCE CREDENTIALS ---
const SF_USERNAME = process.env.SF_USERNAME || 'kai.weaver988.dae61fa699f9@agentforce.com';
const SF_PASSWORD = process.env.SF_PASSWORD || 'Blazer11';
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || 'PTlnkKjZZYoCIcJDDAayq9nh4'; 
const SF_LOGIN_URL = 'https://login.salesforce.com';

const POST_FALLS_COORDS = { latitude: 47.7121, longitude: -116.9482 };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate-limited Nominatim lookup (1.2s pause prevents API rate-limiting drops)
function getCoordinates(locationString) {
  return new Promise((resolve) => {
    if (!locationString || locationString === "UNKNOWN") return resolve(null);

    const cleanLocation = locationString.replace(/DEALER|CARGURUS/gi, '').trim();
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanLocation)}&format=json&limit=1`;
    const options = { headers: { 'User-Agent': 'SalesforceCorollaTracker/2.0' } };

    setTimeout(() => {
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.length > 0) {
              resolve({ latitude: parseFloat(parsed[0].lat), longitude: parseFloat(parsed[0].lon) });
            } else { resolve(null); }
          } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    }, 1200);
  });
}

(async () => {
  let searchUrls = [];
  const jsonPath = path.join(__dirname, 'urls.json');

  if (fs.existsSync(jsonPath)) {
    try {
      searchUrls = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      console.error("Error reading urls.json:", e.message);
      process.exit(1);
    }
  }

  if (!searchUrls || searchUrls.length === 0) {
    console.log("No Search URLs found in urls.json!");
    process.exit(1);
  }

  console.log(`\n1. Launching browser instance...`);
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900'] 
  });

  const detailUrls = new Set();

  // PASS 1: VDP URL Collection
  for (const searchUrl of searchUrls) {
    console.log(`\n Scanning search feed: ${searchUrl}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3500);

      await page.evaluate(() => window.scrollBy(0, 1500));
      await sleep(2000);

      const foundLinks = await page.evaluate(() => {
        const links = [];
        const anchorEls = document.querySelectorAll('a[href*="/details/"], a[href*="entityId="]');
        anchorEls.forEach(a => {
          const href = a.href;
          if (href) {
            const match = href.match(/\/details\/([0-9]+)/);
            if (match) {
              links.push(`https://www.cargurus.com/details/${match[1]}`);
            }
          }
        });
        return links;
      });

      foundLinks.forEach(link => detailUrls.add(link));
      console.log(`   Accumulated ${detailUrls.size} total unique detail links so far.`);

    } catch (err) {
      console.error(` Error scanning feed: ${err.message}`);
    }
    await page.close();
  }

  const vdpList = Array.from(detailUrls);
  console.log(`\n Total Unique Vehicle Detail Pages Discovered: ${vdpList.length}`);

  if (vdpList.length === 0) {
    console.log("No valid detail links discovered.");
    await browser.close();
    process.exit(0);
  }

  // PASS 2: Sequential Deep Spec Parsing
  const processedListings = [];
  const detailPage = await browser.newPage();
  await detailPage.setViewport({ width: 1400, height: 900 });

  for (let i = 0; i < vdpList.length; i++) {
    const vdpUrl = vdpList[i];
    console.log(`\n[${i + 1}/${vdpList.length}] Extracting detail page: ${vdpUrl}`);

    try {
      await detailPage.goto(vdpUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      
      // Scroll down to force React lazy-loaded history and dealer modules to hydrate
      await detailPage.evaluate(() => window.scrollBy(0, 1500));
      await sleep(3000);

      const carData = await detailPage.evaluate(() => {
        const text = document.body.innerText || "";
        
        // 1. VIN Extraction
        const vinMatch = text.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
        const vin = vinMatch ? vinMatch[1].toUpperCase() : null;

        // 2. Price Extraction
        const priceMatch = text.match(/\$([0-9]{2},[0-9]{3})/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : 0;

        // 3. Mileage Extraction
        const mileageMatch = text.match(/([0-9]{1,3},[0-9]{3})\s*(mi|miles)/i);
        const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, ''), 10) : 0;

        // 4. Title / Make / Model
        const titleEl = document.querySelector('h1') || document.querySelector('title');
        const titleText = titleEl ? titleEl.innerText : text;
        const yearMatch = titleText.match(/\b(20[1-2][0-9])\b/) || text.match(/\b(20[1-2][0-9])\b/);
        const year = yearMatch ? yearMatch[1] : "2020";

        let makeModel = "Toyota Corolla SE";
        const upper = titleText.toUpperCase();
        if (upper.includes("CIVIC")) { makeModel = "Honda Civic Sport"; }
        else if (upper.includes("NIGHTSHADE")) { makeModel = "Toyota Corolla Nightshade"; }
        else if (upper.includes("COROLLA")) { makeModel = "Toyota Corolla SE"; }

        // 5. Precision City, State Location Extraction
        let location = "UNKNOWN";
        const cityStateMatches = text.match(/([A-Za-z\s]{3,20}),\s*([A-Z]{2})/g);

        if (cityStateMatches) {
          for (const match of cityStateMatches) {
            const parts = match.split(',');
            const city = parts[0].trim().toUpperCase();
            const state = parts[1].trim().toUpperCase();
            
            if (
              !city.includes("CARGURUS") && 
              !city.includes("PRIVACY") && 
              !city.includes("TERMS") && 
              !city.includes("SEARCH") &&
              !city.includes("DEALER") &&
              city.length > 2 && city.length < 20
            ) {
              location = `${city}, ${state}`;
              break; 
            }
          }
        }

        // 6. Verified Deep Owner Extraction
        let owners = 1; 
        const explicitOwnerMatch = text.match(/([1-9])\s*previous\s*owners?/i) || 
                                   text.match(/([1-9])\s*-(?:owner|Owner)/i) || 
                                   text.match(/([1-9])\s*(?:owner|Owner)s?\b/i) ||
                                   text.match(/Previous\s*owners?:\s*([1-9])/i);

        if (explicitOwnerMatch) {
          owners = parseInt(explicitOwnerMatch[1], 10);
        }

        return { vin, price, mileage, year, makeModel, location, owners };
      });

      if (carData.vin && carData.price > 0) {
        processedListings.push(carData);
        console.log(`  Extracted: ${carData.year} ${carData.makeModel} | $${carData.price} | ${carData.mileage} mi | Owners: ${carData.owners} | Loc: ${carData.location} | VIN: ${carData.vin}`);
      } else {
        console.log(`  Skipped incomplete record.`);
      }

    } catch (err) {
      console.error(`  Error parsing VDP (${vdpUrl}): ${err.message}`);
    }
  }

  await browser.close();

  // Deduplicate
  const uniqueListings = Array.from(new Map(processedListings.map(item => [item.vin, item])).values());
  console.log(`\n Extracted ${uniqueListings.length} verified listings.`);

  if (uniqueListings.length === 0) { process.exit(0); }

  // Sync to Salesforce
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  try {
    await conn.login(SF_USERNAME, SF_PASSWORD + SF_SECURITY_TOKEN);
    console.log(" Connected to Salesforce API!");
  } catch (err) {
    console.error(" Salesforce Login Failed:", err.message);
    process.exit(1);
  }

  for (let i = 0; i < uniqueListings.length; i++) {
    const item = uniqueListings[i];
    let distanceMiles = 0;

    if (item.location !== "UNKNOWN") {
      const coords = await getCoordinates(item.location);
      if (coords) {
        const meters = geolib.getDistance(POST_FALLS_COORDS, coords);
        distanceMiles = Math.round(meters * 0.000621371);
      }
    }

    const payload = {
      "Name": `${item.year} ${item.makeModel} - ${item.location}`,
      "Car_Price__c": item.price,
      "Mileage__c": item.mileage,
      "Previous_Owners__c": item.owners,
      "Make_and_Model__c": item.makeModel,
      "Year__c": item.year,
      "Location__c": item.location,
      "Logistics__c": distanceMiles,
      "VIN__c": item.vin,
    };

    try {
      const result = await conn.sobject("Car_Candidate__c").upsert(payload, 'VIN__c');
      if (result.success) {
        console.log(` [${i + 1}/${uniqueListings.length}] Upserted: ${payload.Name} | $${payload.Car_Price__c} | Distance: ${payload.Logistics__c} mi | Owners: ${payload.Previous_Owners__c}`);
      }
    } catch (err) {
      console.error(` Salesforce Error:`, err.message);
    }
  }

  console.log("\n Deep VDP Multi-Page Sync Complete!");
})();
