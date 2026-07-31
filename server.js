const express = require("express");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

let browser = null;

const DEFAULT_SELECTORS = {
  listing: {
    itemRow: ".ModuleItemRow",
    titleLink: ".news-link a",
    date: ".ModuleDate",
  },
  detail: {
    title: "h1.module-details_title",
    date: "span.module_date-text",
    content: "div.module_body",
  },
};

function mergeSelectors(custom) {
  if (!custom) return DEFAULT_SELECTORS;
  const merge = (defaults, overrides) => {
    const result = { ...defaults };
    for (const [key, val] of Object.entries(overrides || {})) {
      if (val && key !== "extra") result[key] = val;
    }
    return result;
  };
  const merged = {
    listing: merge(DEFAULT_SELECTORS.listing, custom.listing),
    detail: merge(DEFAULT_SELECTORS.detail, custom.detail),
  };
  if (custom.listing && custom.listing.extra) {
    merged.listing.extra = custom.listing.extra;
  }
  return merged;
}

function selectorsAreEmpty(custom) {
  if (!custom) return true;
  const l = custom.listing || {};
  return !l.itemRow && !l.titleLink && !l.date;
}

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

async function fetchPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchAllLoadMore(browser, url, loadMoreSelector, itemRowSelector, sendEvent) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    let detectedApiUrl = null;
    let firstApiData = null;
    page.on("response", async (response) => {
      if (detectedApiUrl) return;
      const req = response.request();
      if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch") return;
      const rUrl = response.url();
      if (!/page=\d+/.test(rUrl)) return;
      try {
        const text = await response.text();
        const body = JSON.parse(text);
        if (body.data && Array.isArray(body.data) && body.data.length > 0) {
          const first = body.data[0];
          if (first.title && (first.link || first.url || first.href)) {
            detectedApiUrl = rUrl;
            firstApiData = body.data;
          }
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    let clickCount = 0;
    let prevCount = 0;
    const rowSel = itemRowSelector;
    let staleRounds = 0;

    while (true) {
      const btn = await page.$(loadMoreSelector);
      if (!btn) break;

      const isVisible = await page.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      }, btn);
      if (!isVisible) break;

      const currentCount = await page.$$eval(rowSel, (els) => els.length).catch(() => 0);
      await page.evaluate((el) => {
        el.scrollIntoView({ block: "center" });
      }, btn);
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate((el) => el.click(), btn);
      clickCount++;
      sendEvent("status", { message: `Clicked "Load More" ${clickCount} time(s)... (${currentCount} items so far)` });

      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      if (detectedApiUrl) {
        sendEvent("status", { message: `Detected paginated API: ${detectedApiUrl}` });
        break;
      }

      const newCount = await page.$$eval(rowSel, (els) => els.length).catch(() => 0);
      if (newCount <= currentCount) {
        staleRounds++;
        if (staleRounds >= 2) break;
      } else {
        staleRounds = 0;
      }
      prevCount = newCount;
    }

    if (detectedApiUrl) {
      sendEvent("status", { message: "Switching to direct API fetch for all pages..." });
      const origin = new URL(url).origin;
      const allItems = [];

      for (let p = 1; p <= 100; p++) {
        const pageUrl = detectedApiUrl.replace(/page=\d+/, `page=${p}`);
        sendEvent("status", { message: `Fetching API page ${p}...` });
        const apiPage = await browser.newPage();
        try {
          await apiPage.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
          );
          const resp = await apiPage.goto(pageUrl, { waitUntil: "networkidle2", timeout: 15000 });
          const text = await resp.text();
          const body = JSON.parse(text);
          if (body.data && Array.isArray(body.data) && body.data.length > 0) {
            allItems.push(...body.data);
            sendEvent("status", { message: `API page ${p}: ${body.data.length} items (total: ${allItems.length})` });
          } else {
            break;
          }
        } catch {
          break;
        } finally {
          await apiPage.close().catch(() => {});
        }
      }

      sendEvent("status", { message: `Fetched ${allItems.length} items from API` });
      await page.close().catch(() => {});

      return {
        apiItems: allItems.map((item) => ({
          title: item.title || "",
          date: item.date || "",
          link: resolveLink(item.link || item.url || item.href || "", origin),
        })),
      };
    }

    const finalCount = await page.$$eval(rowSel, (els) => els.length).catch(() => 0);
    sendEvent("status", { message: `Fully loaded: ${finalCount} items after ${clickCount} click(s)` });
    return { html: await page.content() };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchAllPaginated(browser, url, nextSelector, itemRowSelector, sendEvent) {
  const allHtmlParts = [];
  let pageNum = 1;
  let currentUrl = url;

  while (currentUrl) {
    sendEvent("status", { message: `Loading page ${pageNum}...` });
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      );
      await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 30000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      const itemCount = $(itemRowSelector).length;
      sendEvent("status", { message: `Page ${pageNum}: found ${itemCount} items` });
      allHtmlParts.push(html);

      const nextLink = await page.$(nextSelector);
      if (nextLink) {
        const href = await page.evaluate((el) => el.href || el.getAttribute("href"), nextLink);
        if (href && href !== currentUrl && href !== "#") {
          currentUrl = href.startsWith("http") ? href : new URL(href, currentUrl).href;
          pageNum++;
        } else {
          currentUrl = null;
        }
      } else {
        currentUrl = null;
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  sendEvent("status", { message: `Loaded ${pageNum} page(s) total` });
  return allHtmlParts;
}

async function detectApiPagination(browser, url, sendEvent) {
  const page = await browser.newPage();
  let detectedApi = null;

  page.on("response", async (response) => {
    if (detectedApi) return;
    const req = response.request();
    if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch") return;
    try {
      const text = await response.text();
      const body = JSON.parse(text);
      if (body.data && Array.isArray(body.data) && body.data.length > 0) {
        const first = body.data[0];
        if (first.title && (first.link || first.url || first.href)) {
          detectedApi = { url: response.url(), data: body };
        }
      }
    } catch {}
  });

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    await page.close().catch(() => {});
  }

  if (!detectedApi) return null;

  const meta = detectedApi.data.meta || {};
  const totalPages = meta.totalPage || meta.totalPages || meta.total_pages || 0;
  const totalItems = meta.totalItemCount || meta.totalItems || meta.total || 0;

  return {
    apiUrl: detectedApi.url,
    firstPageData: detectedApi.data.data,
    totalPages,
    totalItems,
    siteUrl: meta.siteUrl || new URL(url).origin,
  };
}

async function fetchAllApiPages(browser, apiInfo, sendEvent) {
  const allItems = [...apiInfo.firstPageData];
  const origin = apiInfo.siteUrl;
  const maxPages = apiInfo.totalPages || 100;

  if (apiInfo.totalPages === 1) {
    return allItems.map((item) => ({
      title: item.title || "",
      date: item.date || "",
      link: resolveLink(item.link || item.url || item.href || "", origin),
    }));
  }

  sendEvent("status", {
    message: `Detected API: ${apiInfo.totalItems || "?"} items across ${apiInfo.totalPages || "unknown"} pages. Fetching all...`,
  });

  for (let p = 2; p <= maxPages; p++) {
    const pageUrl = apiInfo.apiUrl.replace(/page=\d+/, `page=${p}`);
    sendEvent("status", { message: `Fetching API page ${p}${apiInfo.totalPages ? ` of ${apiInfo.totalPages}` : ""}...` });
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      );
      const resp = await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 15000 });
      const text = await resp.text();
      const body = JSON.parse(text);
      if (body.data && Array.isArray(body.data) && body.data.length > 0) {
        allItems.push(...body.data);
      } else {
        break;
      }
    } catch {
      break;
    } finally {
      await page.close().catch(() => {});
    }
  }

  sendEvent("status", { message: `Fetched ${allItems.length} items from API` });

  return allItems.map((item) => ({
    title: item.title || "",
    date: item.date || "",
    link: resolveLink(item.link || item.url || item.href || "", origin),
  }));
}

async function autoDetectListingSelectors(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    return await page.evaluate(() => {
      const DATE_RE = /\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}/i;

      const classGroups = {};
      document.querySelectorAll("*").forEach((el) => {
        if (!el.className || typeof el.className !== "string") return;
        el.className.trim().split(/\s+/).forEach((cls) => {
          if (!cls || cls.length > 50) return;
          const key = "." + cls;
          if (!classGroups[key]) classGroups[key] = [];
          classGroups[key].push(el);
        });
      });

      const GENERIC_CLASSES = /^(col-|row|container|wrapper|section|block|grid|flex|d-|p-|m-|mb-|mt-|px-|py-|bg-|text-|align-|justify-)/;
      const SEMANTIC_HINTS = /post|news|article|card|item|press|release|entry|blog|story|result|listing/i;

      const candidates = Object.entries(classGroups)
        .filter(([, els]) => els.length >= 3 && els.length <= 200)
        .map(([selector, els]) => {
          let withLinks = 0, withDates = 0, avgTextLen = 0;
          els.forEach((el) => {
            if (el.querySelector("a[href]")) withLinks++;
            if (DATE_RE.test(el.textContent)) withDates++;
            avgTextLen += el.textContent.trim().length;
          });
          avgTextLen = avgTextLen / els.length;
          const cls = selector.replace(".", "");
          const isGeneric = GENERIC_CLASSES.test(cls);
          const isSemantic = SEMANTIC_HINTS.test(cls);
          return { selector, count: els.length, withLinks, withDates, avgTextLen, sample: els[0], isGeneric, isSemantic };
        })
        .filter((c) => c.withLinks >= 3 && c.withDates >= 2 && c.avgTextLen > 10 && c.avgTextLen < 2000)
        .sort((a, b) => {
          const scoreA = a.withLinks + a.withDates + (a.isSemantic ? 10 : 0) - (a.isGeneric ? 8 : 0);
          const scoreB = b.withLinks + b.withDates + (b.isSemantic ? 10 : 0) - (b.isGeneric ? 8 : 0);
          return scoreB - scoreA;
        });

      if (candidates.length === 0) return null;

      const best = candidates[0];
      const sampleEl = best.sample;

      let titleLinkSel = "a";
      const links = sampleEl.querySelectorAll("a[href]");
      for (const link of links) {
        const text = link.textContent.trim();
        if (text.length > 10 && link.href && !link.href.includes("#")) {
          if (link.className && link.className.trim()) {
            titleLinkSel = "a." + link.className.trim().split(/\s+/)[0];
          } else {
            const parent = link.parentElement;
            if (parent && parent !== sampleEl && parent.className && parent.className.trim()) {
              titleLinkSel = "." + parent.className.trim().split(/\s+/)[0] + " a";
            }
          }
          break;
        }
      }

      let dateSel = "";
      const innerEls = sampleEl.querySelectorAll("*");
      for (const inner of innerEls) {
        const text = inner.textContent.trim();
        if (DATE_RE.test(text) && inner.children.length <= 1 && text.length < 100) {
          if (inner.className && inner.className.trim()) {
            dateSel = "." + inner.className.trim().split(/\s+/)[0];
          } else if (inner.tagName === "TIME") {
            dateSel = "time";
          } else {
            dateSel = inner.tagName.toLowerCase();
          }
          break;
        }
      }

      let documentSel = "";
      const DOC_EXT = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)(\?|#|$)/i;
      const sampleLinks = sampleEl.querySelectorAll("a[href]");
      for (const a of sampleLinks) {
        const href = a.href || a.getAttribute("href") || "";
        const text = a.textContent.trim().toLowerCase();
        if (DOC_EXT.test(href) || /\b(download|document|attachment|pdf)\b/.test(text)) {
          if (a.className && a.className.trim()) {
            documentSel = "." + a.className.trim().split(/\s+/)[0];
          } else {
            const p = a.parentElement;
            if (p && p !== sampleEl && p.className && p.className.trim()) {
              documentSel = "." + p.className.trim().split(/\s+/)[0] + " a";
            } else {
              documentSel = "a";
            }
          }
          break;
        }
      }

      return { itemRow: best.selector, titleLink: titleLinkSel, date: dateSel, document: documentSel, count: best.count };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function autoDetectDetailSelectors(browser, detailUrl) {
  const html = await fetchPage(browser, detailUrl);
  const $ = cheerio.load(html);
  const DATE_RE = /\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}/i;
  const GENERIC_CLASSES = /^(col-|row|container|wrapper|section|block|grid|flex|d-|p-|m-|mb-|mt-|px-|py-|bg-|text-|align-|justify-|main-|page-|site-|layout)/;

  let titleSel = "h1";
  const h1 = $("h1").first();
  if (h1.length) {
    const cls = h1.attr("class");
    if (cls && cls.trim()) titleSel = "h1." + cls.trim().split(/\s+/)[0];
  }

  let dateSel = "";
  $("time, [class*='date'], [class*='Date']").each((_, el) => {
    if (dateSel) return;
    const text = $(el).text().trim();
    if (DATE_RE.test(text) && text.length < 100) {
      const cls = $(el).attr("class");
      if (cls && cls.trim()) {
        const firstCls = cls.trim().split(/\s+/)[0];
        if (!GENERIC_CLASSES.test(firstCls)) dateSel = "." + firstCls;
      }
      if (!dateSel && el.tagName.toLowerCase() === "time") dateSel = "time";
    }
  });
  if (!dateSel) {
    $("span, p").each((_, el) => {
      if (dateSel) return;
      const text = $(el).text().trim();
      if (DATE_RE.test(text) && text.length < 80 && $(el).children().length <= 1) {
        const cls = $(el).attr("class");
        if (cls && cls.trim()) {
          const firstCls = cls.trim().split(/\s+/)[0];
          if (!GENERIC_CLASSES.test(firstCls)) dateSel = "." + firstCls;
        }
      }
    });
  }

  let contentSel = "";
  let maxScore = 0;
  $("div, article, section").each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const pCount = $el.find("p").length;
    if (text.length < 200 || pCount < 2) return;
    const cls = $el.attr("class");
    const firstCls = cls && cls.trim() ? cls.trim().split(/\s+/)[0] : "";
    if (GENERIC_CLASSES.test(firstCls)) return;
    const score = pCount * 10 + Math.min(text.length, 5000);
    const parentLen = $el.parent().text().trim().length;
    if (score > maxScore && text.length < parentLen * 0.9) {
      maxScore = score;
      contentSel = firstCls ? "." + firstCls : el.tagName.toLowerCase();
    }
  });

  return { title: titleSel, date: dateSel, content: contentSel };
}

function resolveLink(link, origin) {
  if (!link) return "";
  if (link.startsWith("http")) return link;
  return origin.replace(/\/$/, "") + (link.startsWith("/") ? "" : "/") + link;
}

function parseDateFlexible(dateStr) {
  const months = {
    jan: "01", january: "01", feb: "02", february: "02",
    mar: "03", march: "03", apr: "04", april: "04",
    may: "05", jun: "06", june: "06", jul: "07", july: "07",
    aug: "08", august: "08", sep: "09", september: "09",
    oct: "10", october: "10", nov: "11", november: "11",
    dec: "12", december: "12",
  };

  const cleaned = dateStr.replace(/\s*[-|]\s*.*$/, "").trim();

  // "Month DD, YYYY" — e.g. "May 16, 2026"
  let m = cleaned.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mm = months[m[1].toLowerCase()] || "01";
    const dd = m[2].padStart(2, "0");
    return { formatted: `${dd}/${mm}/${m[3]} 13:00`, namePrefix: `${mm}-${dd}-${m[3]}`, year: m[3] };
  }

  // "DD Month YYYY" — e.g. "16 May 2026"
  m = cleaned.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (m) {
    const mm = months[m[2].toLowerCase()] || "01";
    const dd = m[1].padStart(2, "0");
    return { formatted: `${dd}/${mm}/${m[3]} 13:00`, namePrefix: `${mm}-${dd}-${m[3]}`, year: m[3] };
  }

  // "YYYY-MM-DD"
  m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { formatted: `${m[3]}/${m[2]}/${m[1]} 13:00`, namePrefix: `${m[2]}-${m[3]}-${m[1]}`, year: m[1] };
  }

  // "MM/DD/YYYY"
  m = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    return { formatted: `${m[2]}/${m[1]}/${m[3]} 13:00`, namePrefix: `${m[1]}-${m[2]}-${m[3]}`, year: m[3] };
  }

  // Try to extract any 4-digit year
  m = cleaned.match(/(\d{4})/);
  if (m) {
    return { formatted: "", namePrefix: "", year: m[1] };
  }

  return { formatted: "", namePrefix: "", year: "" };
}

function generateId() {
  return String(Math.floor(Math.random() * 900000000) + 100000000);
}

function extractItemsFromHtml(html, sel, baseUrl) {
  const $ = cheerio.load(html);
  const origin = baseUrl ? new URL(baseUrl).origin : "";
  const items = [];

  let rowSelector = sel.listing.itemRow;

  if (rowSelector && rowSelector.startsWith(".")) {
    const cls = rowSelector.slice(1);
    // Handle ASP.NET alternating row pattern (e.g. .ModuleItem / .ModuleItemAlt)
    if (!cls.endsWith("Alt") && $(rowSelector + "Alt").length > 0) {
      rowSelector = rowSelector + ", " + rowSelector + "Alt";
    } else if (cls.endsWith("Alt") && $("." + cls.replace(/Alt$/, "")).length > 0) {
      rowSelector = "." + cls.replace(/Alt$/, "") + ", " + rowSelector;
    }
    // Check if matched elements share a broader class that captures more items
    const initial = $(rowSelector);
    if (initial.length > 0) {
      const classes = (initial.first().attr("class") || "").trim().split(/\s+/);
      for (const c of classes) {
        if ("." + c === sel.listing.itemRow) continue;
        const broader = "." + c;
        const broaderEls = $(broader);
        if (broaderEls.length > initial.length) {
          let valid = 0;
          broaderEls.each((_, el) => { if ($(el).find("a[href]").length > 0) valid++; });
          if (valid >= broaderEls.length * 0.8) {
            rowSelector = broader;
            break;
          }
        }
      }
    }
  }

  const extra = (sel.listing && sel.listing.extra) || {};

  $(rowSelector).each((_, row) => {
    let titleEl = $(row).find(sel.listing.titleLink);
    const title = titleEl.text().trim();
    let link = titleEl.attr("href") || "";
    if (!link) {
      const childA = titleEl.find("a[href]").first();
      if (childA.length) link = childA.attr("href") || "";
    }
    if (link && origin) link = resolveLink(link, origin);
    const date = $(row).find(sel.listing.date).text().trim();
    if (title && link) {
      const item = { date, title, link };
      for (const [key, exSel] of Object.entries(extra)) {
        if (!exSel) continue;
        const el = $(row).find(exSel).first();
        let val = el.attr("href") || el.attr("src") || "";
        if (!val) {
          const childA = el.find("a[href]").first();
          val = childA.attr("href") || "";
        }
        if (val && !val.startsWith("http") && origin) val = resolveLink(val, origin);
        const itemKey = key.toLowerCase() === "link" ? "_fvsLink" : key;
        item[itemKey] = val || el.text().trim();
      }
      items.push(item);
    }
  });
  return items;
}

async function scrapeDetailPage(browser, url, sel, autoDetectedDetail, fieldTypes, listingData) {
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i.test(url)) {
    const listing = listingData || {};
    return { sourceUrl: url, title: listing.title || "", date: listing.date || "", content: "", link: url };
  }
  const html = await fetchPage(browser, url);
  const $ = cheerio.load(html);
  const DATE_RE = /\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}/i;
  const listing = listingData || {};

  const useSel = autoDetectedDetail || sel.detail;
  const result = { sourceUrl: url };

  const titleSel = useSel.title || "";
  result.title = titleSel ? $(titleSel).first().text().trim() : "";
  if (!result.title && listing.title) {
    result.title = listing.title;
  } else if (!result.title) {
    result.title = $("h1").first().text().trim();
  }

  const dateSel = useSel.date || "";
  result.date = dateSel ? $(dateSel).first().text().trim() : "";
  if (!result.date && listing.date) {
    result.date = listing.date;
  } else if (!result.date) {
    $("time, [class*='date'], [class*='Date'], span, p").each((_, el) => {
      if (result.date) return;
      const text = $(el).text().trim();
      if (DATE_RE.test(text) && text.length < 100) result.date = text;
    });
  }

  const contentSel = useSel.content || "";
  result.content = contentSel ? ($(contentSel).first().html() || "").trim() : "";
  if (!result.content) {
    let maxScore = 0;
    $("div, article, section, main").each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const pCount = $el.find("p").length;
      if (text.length < 200 || pCount < 1) return;
      const score = pCount * 10 + Math.min(text.length, 5000);
      const parentLen = $el.parent().text().trim().length;
      if (score > maxScore && text.length < parentLen * 0.9) {
        maxScore = score;
        result.content = $el.html() || "";
      }
    });
  }

  const linkSel = useSel.link || "";
  let linkVal = "";
  if (linkSel) {
    const linkEl = $(linkSel).first();
    linkVal = linkEl.attr("href") || linkEl.attr("src") || "";
  }
  if (!linkVal) {
    const PDF_EXT = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;
    $("a[href]").each((_, el) => {
      if (linkVal) return;
      const href = $(el).attr("href") || "";
      if (PDF_EXT.test(href)) linkVal = href;
    });
  }
  if (linkVal && !linkVal.startsWith("http")) {
    try { linkVal = new URL(linkVal, url).href; } catch { }
  }
  result.link = linkVal || url;

  const CORE_FIELDS = new Set(["title", "date", "content", "link"]);
  for (const [fieldName, fieldSel] of Object.entries(useSel)) {
    if (CORE_FIELDS.has(fieldName) || !fieldSel) continue;
    const el = $(fieldSel).first();
    let val = el.attr("href") || el.attr("src") || "";
    if (val && !val.startsWith("http")) {
      try { val = new URL(val, url).href; } catch { }
    }
    if (!val) val = el.text().trim();
    if (val) result[fieldName] = val;
  }

  if (!result.title) result.title = listing.title || "";
  if (!result.date) result.date = listing.date || "";
  if (!result.content) result.content = "";

  return result;
}

function analyzeTemplate(sampleJson) {
  const sitemapKey = Object.keys(sampleJson).find((k) => {
    const val = sampleJson[k];
    return Array.isArray(val) && val.length > 0 && val[0].Level !== undefined;
  });

  if (!sitemapKey) return null;

  const sitemap = sampleJson[sitemapKey];
  const fvsKeys = Object.keys(sampleJson["Field Value Source"] || sampleJson["Field Type Specification"] || {});
  const META_LOWER = new Set(["name", "level", "hierarchy", "itempath", "children", "template name", "template path", "template id"]);

  function hasDataFields(node) {
    if (fvsKeys.length > 0) return fvsKeys.some((k) => node[k] !== undefined);
    return Object.keys(node).some((k) => !META_LOWER.has(k.toLowerCase()));
  }

  function levelScore(levelStr) {
    const parts = String(levelStr || "0").split(".");
    let score = 0;
    for (let i = 0; i < parts.length; i++) {
      score += (parseInt(parts[i]) || 0) / Math.pow(1000, i);
    }
    return score;
  }

  function findBestPair(nodes, parent) {
    let best = null;
    for (const node of nodes) {
      if (node.Children && node.Children.length > 0) {
        const deeper = findBestPair(node.Children, node);
        if (deeper && (!best || deeper.score > best.score)) best = deeper;
      } else if (hasDataFields(node)) {
        const s = levelScore(node.Level);
        if (!best || s > best.score) best = { item: node, group: parent, score: s };
      }
    }
    return best;
  }

  let rootTemplate = null;
  let groupTemplate = null;
  let itemTemplate = null;
  let staticNodes = [];
  let groupStartLevel = 1;

  const isNested =
    sitemap.length === 1 && sitemap[0].Children && sitemap[0].Children.length > 0;

  rootTemplate = JSON.parse(JSON.stringify(sitemap[0]));
  rootTemplate.Children = [];

  const pool = isNested ? sitemap[0].Children : sitemap.slice(1);

  let bestPair = null;
  let bestPoolIdx = -1;

  for (let i = 0; i < pool.length; i++) {
    const node = pool[i];
    if (!node.Children || node.Children.length === 0) continue;
    const pair = findBestPair(node.Children, node);
    if (pair && (!bestPair || pair.score > bestPair.score)) {
      bestPair = pair;
      bestPoolIdx = i;
    }
  }

  if (bestPair) {
    groupTemplate = JSON.parse(JSON.stringify(bestPair.group));
    groupTemplate.Children = [];
    groupStartLevel = parseInt(String(bestPair.group.Level || "1").split(".")[0]) || 1;
    itemTemplate = JSON.parse(JSON.stringify(bestPair.item));
    for (let i = 0; i < bestPoolIdx; i++) {
      staticNodes.push(JSON.parse(JSON.stringify(pool[i])));
    }
  } else {
    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      if (node.Children && node.Children.length > 0) {
        groupTemplate = JSON.parse(JSON.stringify(node));
        groupTemplate.Children = [];
        groupStartLevel = parseInt(String(node.Level || "1").split(".")[0]) || 1;
        itemTemplate = JSON.parse(JSON.stringify(node.Children[0]));
        break;
      }
    }
  }

  const staticKeys = {};
  for (const [key, val] of Object.entries(sampleJson)) {
    if (key !== sitemapKey) staticKeys[key] = val;
  }

  const fieldValueSource = sampleJson["Field Value Source"] || null;
  const fieldTypeSpec = sampleJson["Field Type Specification"] || null;

  if (itemTemplate) {
    const allFieldKeys = new Set([
      ...Object.keys(fieldValueSource || {}),
      ...Object.keys(fieldTypeSpec || {}),
    ]);
    for (const k of allFieldKeys) {
      if (itemTemplate[k] === undefined) itemTemplate[k] = "";
    }
  }

  return { sitemapKey, rootTemplate, groupTemplate, itemTemplate, staticKeys, isNested, fieldValueSource, fieldTypeSpec, staticNodes, groupStartLevel };
}

function formatSitecoreLink(url, text) {
  const escapedUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const escapedText = (text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<link text="${escapedText}" linktype="external" url="${escapedUrl}" anchor="" target="_blank" />`;
}

function buildItemFromTemplate(template, data, fieldTypes) {
  const item = JSON.parse(JSON.stringify(template));
  const META_KEYS = new Set(["name", "level", "hierarchy", "itempath", "children", "template name", "template path", "template id"]);
  const linkTypes = new Set();
  if (fieldTypes) {
    for (const [k, v] of Object.entries(fieldTypes)) {
      if (/general\s*link/i.test(String(v))) linkTypes.add(k.toLowerCase());
    }
  }
  for (const key of Object.keys(item)) {
    const lower = key.toLowerCase();
    if (lower === "name") item[key] = data.name;
    else if (lower === "level") item[key] = data.level;
    else if (lower === "hierarchy") item[key] = data.hierarchy;
    else if (lower === "itempath") item[key] = data.itemPath;
    else if (lower === "children") item[key] = [];
    else if (!META_KEYS.has(lower)) {
      let val = data[lower] !== undefined ? data[lower] : (data[key] !== undefined ? data[key] : "");
      item[key] = val;
    }
  }
  return item;
}

function buildGroupFromTemplate(template, data) {
  const group = JSON.parse(JSON.stringify(template));
  const META_KEYS = new Set(["name", "level", "hierarchy", "itempath", "children", "title", "template name", "template path", "template id"]);
  for (const key of Object.keys(group)) {
    const lower = key.toLowerCase();
    if (lower === "title") group[key] = data.title;
    else if (lower === "name") group[key] = data.name;
    else if (lower === "level") group[key] = data.level;
    else if (lower === "hierarchy") group[key] = data.hierarchy;
    else if (lower === "itempath") group[key] = data.itemPath;
    else if (lower === "children") group[key] = data.children || [];
    else if (!META_KEYS.has(lower)) group[key] = "";
  }
  return group;
}

function buildOutput(analysis, allDetailResults, usedDetailSelectors, usedListingExtra) {
  const yearGroups = {};
  allDetailResults.forEach((item) => {
    const parsed = parseDateFlexible(item.date);
    const year = parsed.year || "unknown";
    if (!yearGroups[year]) yearGroups[year] = [];
    yearGroups[year].push({ ...item, parsed });
  });

  const sortedYears = Object.keys(yearGroups).sort((a, b) => b - a);
  const rootItemPath = analysis.rootTemplate.ItemPath || "";
  const output = { ...analysis.staticKeys };

  if (output["Field Value Source"] !== undefined) {
    const fvs = {};
    const origFvs = output["Field Value Source"] || {};
    for (const key of Object.keys(origFvs)) {
      fvs[key] = "";
    }
    output["Field Value Source"] = fvs;
  }

  const groupStartLevel = analysis.groupStartLevel || 1;
  const staticNodes = analysis.staticNodes || [];

  if (analysis.isNested) {
    const rootNode = JSON.parse(JSON.stringify(analysis.rootTemplate));
    rootNode.Children = [];

    for (const sn of staticNodes) {
      rootNode.Children.push(sn);
    }

    sortedYears.forEach((year, yearIdx) => {
      const levelNum = groupStartLevel + yearIdx;
      const yearItemPath = `${rootItemPath}/${year}`;

      const yearChildren = yearGroups[year].map((item, itemIdx) => {
        const id = generateId();
        const name = item.parsed.namePrefix
          ? `${item.parsed.namePrefix}-${id}`
          : `${year}-${id}`;
        const { parsed, sourceUrl, ...scraped } = item;
        return buildItemFromTemplate(analysis.itemTemplate, {
          ...scraped, date: item.parsed.formatted,
          name, level: `${levelNum}.${itemIdx + 1}`, hierarchy: `${levelNum}.${itemIdx + 1}`,
          itemPath: `${yearItemPath}/${name}`,
        }, analysis.fieldTypeSpec);
      });

      rootNode.Children.push(buildGroupFromTemplate(analysis.groupTemplate, {
        title: year, name: year, level: String(levelNum), hierarchy: String(levelNum),
        itemPath: yearItemPath, children: yearChildren,
      }));
    });

    output[analysis.sitemapKey] = [rootNode];
  } else {
    const rootNode = JSON.parse(JSON.stringify(analysis.rootTemplate));
    output[analysis.sitemapKey] = [rootNode];

    for (const sn of staticNodes) {
      output[analysis.sitemapKey].push(sn);
    }

    sortedYears.forEach((year, yearIdx) => {
      const levelNum = groupStartLevel + yearIdx;
      const yearItemPath = `${rootItemPath}/${year}`;

      const yearChildren = yearGroups[year].map((item, itemIdx) => {
        const id = generateId();
        const name = item.parsed.namePrefix
          ? `${item.parsed.namePrefix}-${id}`
          : `${year}-${id}`;
        const { parsed, sourceUrl, ...scraped } = item;
        return buildItemFromTemplate(analysis.itemTemplate, {
          ...scraped, date: item.parsed.formatted,
          name, level: `${levelNum}.${itemIdx + 1}`, hierarchy: `${levelNum}.${itemIdx + 1}`,
          itemPath: `${yearItemPath}/${name}`,
        }, analysis.fieldTypeSpec);
      });

      output[analysis.sitemapKey].push(buildGroupFromTemplate(analysis.groupTemplate, {
        title: year, name: year, level: String(levelNum), hierarchy: String(levelNum),
        itemPath: yearItemPath, children: yearChildren,
      }));
    });
  }

  return output;
}

function extractYearFromUrl(url) {
  const match = url.match(/\/(\d{4})(\/|$)/);
  return match ? match[1] : null;
}

function buildUrlForYear(url, year) {
  if (/\/\d{4}(\/|$)/.test(url)) {
    return url.replace(/\/\d{4}(\/|$)/, `/${year}$1`);
  }
  const base = url.endsWith("/") ? url : url + "/";
  return base + year + "/";
}

async function discoverYearLinksFromPage(b, url) {
  const html = await fetchPage(b, url);
  const $ = cheerio.load(html);
  const origin = new URL(url).origin;
  const yearMap = new Map();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    const fullHref = href.startsWith("http") ? href : origin + (href.startsWith("/") ? "" : "/") + href;
    const match = fullHref.match(/\/(\d{4})(\/|$)/);
    if (match) {
      const y = parseInt(match[1]);
      if (y >= 1990 && y <= new Date().getFullYear() + 1 && !yearMap.has(y)) {
        yearMap.set(y, fullHref);
      }
    } else if (/^\d{4}$/.test(text)) {
      const y = parseInt(text);
      if (y >= 1990 && y <= new Date().getFullYear() + 1 && !yearMap.has(y)) {
        const hashPart = href.split("#").pop();
        if (hashPart && hashPart.startsWith("http")) {
          yearMap.set(y, hashPart);
        }
      }
    }
  });

  const years = [...yearMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, yearUrl]) => ({ year: String(year), url: yearUrl }));
  return years;
}

// ─── API Endpoints ───

app.post("/api/auto-detect", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const b = await getBrowser();
    const listing = await autoDetectListingSelectors(b, url);

    let detail = null;
    if (listing) {
      const html = await fetchPage(b, url);
      const $ = cheerio.load(html);
      const firstLink = $(listing.itemRow).first().find(listing.titleLink.includes(" ") ? listing.titleLink.split(" ").pop() : listing.titleLink);
      let href = firstLink.attr("href") || "";
      if (href && !href.startsWith("http")) {
        const origin = new URL(url).origin;
        href = origin + (href.startsWith("/") ? "" : "/") + href;
      }
      if (href) {
        detail = await autoDetectDetailSelectors(b, href);
      }
    }

    res.json({
      listing: listing ? { itemRow: listing.itemRow, titleLink: listing.titleLink, date: listing.date, document: listing.document || "" } : null,
      detail: detail || null,
      itemCount: listing ? listing.count : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/discover-years", async (req, res) => {
  const { url, selectors: customSel } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const b = await getBrowser();
  let sel = mergeSelectors(customSel);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (selectorsAreEmpty(customSel)) {
      sendEvent("status", { message: "No selectors provided. Auto-detecting..." });
      const detected = await autoDetectListingSelectors(b, url);
      if (detected) {
        sel = { listing: { itemRow: detected.itemRow, titleLink: detected.titleLink, date: detected.date, extra: detected.document ? { document: detected.document } : {} }, detail: sel.detail };
        sendEvent("status", { message: `Auto-detected: row=${detected.itemRow}, link=${detected.titleLink}, date=${detected.date}` });
        sendEvent("detected", { listing: sel.listing });
      }
    }
    const hasYearInUrl = /\/\d{4}(\/|$)/.test(url);
    const found = [];

    if (!hasYearInUrl) {
      sendEvent("status", { message: "No year in URL. Scanning page for year links..." });
      const yearLinks = await discoverYearLinksFromPage(b, url);

      if (yearLinks.length > 0) {
        sendEvent("status", { message: `Found ${yearLinks.length} year links on page. Checking each...` });

        if (selectorsAreEmpty(customSel) && !sel._autoDetected) {
          const firstYearUrl = yearLinks[0].url;
          const detected = await autoDetectListingSelectors(b, firstYearUrl);
          if (detected) {
            sel = { listing: { itemRow: detected.itemRow, titleLink: detected.titleLink, date: detected.date, extra: detected.document ? { document: detected.document } : {} }, detail: sel.detail, _autoDetected: true };
            sendEvent("status", { message: `Auto-detected: row=${detected.itemRow}, link=${detected.titleLink}, date=${detected.date}` });
            sendEvent("detected", { listing: sel.listing });
          }
        }

        for (const yl of yearLinks) {
          sendEvent("scanning", { year: parseInt(yl.year), message: `Checking ${yl.year}...` });
          try {
            const html = await fetchPage(b, yl.url);
            const $ = cheerio.load(html);
            const count = $(sel.listing.itemRow).length;
            if (count > 0) {
              found.push({ year: yl.year, count, url: yl.url });
              sendEvent("found", { year: parseInt(yl.year), count, url: yl.url, message: `${yl.year}: ${count} press releases` });
            }
          } catch {}
        }
      } else {
        sendEvent("status", { message: "No year links found. Trying URL patterns..." });
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= 2000; y--) {
          const testUrl = buildUrlForYear(url, y);
          sendEvent("scanning", { year: y, message: `Checking ${y}...` });
          try {
            const html = await fetchPage(b, testUrl);
            const $ = cheerio.load(html);
            const count = $(sel.listing.itemRow).length;
            if (count > 0) {
              found.push({ year: String(y), count, url: testUrl });
              sendEvent("found", { year: y, count, url: testUrl, message: `${y}: ${count} press releases` });
            }
          } catch {}
        }
      }
    } else {
      const currentYear = new Date().getFullYear();
      sendEvent("status", { message: `Scanning years ${currentYear} down to 2000...` });
      for (let y = currentYear; y >= 2000; y--) {
        const testUrl = buildUrlForYear(url, y);
        sendEvent("scanning", { year: y, message: `Checking ${y}...` });
        try {
          const html = await fetchPage(b, testUrl);
          const $ = cheerio.load(html);
          const count = $(sel.listing.itemRow).length;
          if (count > 0) {
            found.push({ year: String(y), count, url: testUrl });
            sendEvent("found", { year: y, count, url: testUrl, message: `${y}: ${count} press releases` });
          }
        } catch {}
      }
    }

    sendEvent("done", { years: found });
    res.end();
  } catch (err) {
    sendEvent("error", { message: err.message });
    res.end();
  }
});

app.post("/api/scrape", async (req, res) => {
  const { url, template, years, yearUrls, selectors: customSel } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!template) return res.status(400).json({ error: "Sample JSON template is required" });

  const analysis = analyzeTemplate(template);
  if (!analysis) return res.status(400).json({ error: "Could not detect Sitemap structure in uploaded JSON" });

  let sel = mergeSelectors(customSel);
  const b = await getBrowser();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (selectorsAreEmpty(customSel)) {
      sendEvent("status", { message: "No selectors provided. Auto-detecting..." });
      const detected = await autoDetectListingSelectors(b, url);
      if (detected) {
        sel = { listing: { itemRow: detected.itemRow, titleLink: detected.titleLink, date: detected.date, extra: detected.document ? { document: detected.document } : {} }, detail: sel.detail };
        sendEvent("status", { message: `Auto-detected: row=${detected.itemRow}, link=${detected.titleLink}, date=${detected.date}` });
        sendEvent("detected", { listing: sel.listing });
      }
    }

    let urlsToScrape = [];
    if (years && years.length > 0) {
      urlsToScrape = years.map((y) => ({
        year: y,
        url: (yearUrls && yearUrls[y]) ? yearUrls[y] : buildUrlForYear(url, y),
      }));
    } else {
      urlsToScrape = [{ year: extractYearFromUrl(url) || "unknown", url }];
    }

    let detailSelOverride = null;
    const detailEmpty = !customSel || !customSel.detail || !Object.values(customSel.detail).some((v) => v);

    if (detailEmpty && analysis.fieldValueSource) {
      const fvs = analysis.fieldValueSource;
      const DETAIL_FIELDS = new Set(["title", "date", "content"]);
      const hasAnySelector = Object.values(fvs).some((v) => v);
      if (hasAnySelector) {
        detailSelOverride = { ...fvs };
        for (const dk of Object.keys(detailSelOverride)) {
          if (dk.toLowerCase() === "link") delete detailSelOverride[dk];
        }
        const extraFvs = {};
        for (const [k, v] of Object.entries(fvs)) {
          const lower = k.toLowerCase();
          if (DETAIL_FIELDS.has(lower) || !v) continue;
          if (lower === "link") {
            extraFvs["_fvsLink"] = v;
          } else {
            extraFvs[k] = v;
          }
        }
        console.log(`[FVS] detailSelOverride=${JSON.stringify(Object.keys(detailSelOverride))} extraFvs=${JSON.stringify(extraFvs)}`);
        if (Object.keys(extraFvs).length > 0) {
          sel.listing.extra = { ...(sel.listing.extra || {}), ...extraFvs };
        }
        console.log(`[FVS] listing.extra=${JSON.stringify(sel.listing.extra)}`);
        const selSummary = Object.entries(fvs).map(([k, v]) => `${k}=${v || "auto"}`).join(", ");
        sendEvent("status", { message: `Using Field Value Source selectors: ${selSummary}` });
        sendEvent("detected", { detail: detailSelOverride });
      }
    }

    const allDetailResults = [];
    let totalItems = 0;
    let scrapedItems = 0;

    for (const entry of urlsToScrape) {
      sendEvent("status", { message: `Loading ${entry.year} listing page...` });
      const html = await fetchPage(b, entry.url);
      const items = extractItemsFromHtml(html, sel, entry.url);
      totalItems += items.length;
      sendEvent("status", { message: `${entry.year}: Found ${items.length} press releases. Scraping details...` });

      if (!detailSelOverride && detailEmpty && items.length > 0) {
        sendEvent("status", { message: "Auto-detecting detail page selectors..." });
        const firstLink = items[0].link.startsWith("http") ? items[0].link : new URL(items[0].link, entry.url).href;
        detailSelOverride = await autoDetectDetailSelectors(b, firstLink);
        if (detailSelOverride && analysis.fieldValueSource) {
          for (const key of Object.keys(analysis.fieldValueSource)) {
            if (detailSelOverride[key] === undefined) detailSelOverride[key] = "";
          }
        }
        if (detailSelOverride) {
          const selSummary = Object.entries(detailSelOverride).map(([k, v]) => `${k}=${v || "none"}`).join(", ");
          sendEvent("status", { message: `Detail auto-detected: ${selSummary}` });
          sendEvent("detected", { detail: detailSelOverride });
        }
      }

      const BATCH_SIZE = 3;
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map((item) => {
            const { title, date, link, _fvsLink, ...listingExtra } = item;
            console.log(`[BATCH] "${title}" navLink=${link} _fvsLink=${_fvsLink || "EMPTY"}`);
            return scrapeDetailPage(b, link, sel, detailSelOverride, analysis.fieldTypeSpec, { title, date }).then(
              (detail) => {
                console.log(`[DETAIL] "${title}" detail.link=${detail.link} navLink=${link} willReplace=${!!(_fvsLink && detail.link === link)}`);
                if (_fvsLink && detail.link === link) detail.link = _fvsLink;
                const merged = { ...listingExtra, ...detail };
                delete merged._fvsLink;
                console.log(`[MERGED] "${title}" merged.link=${merged.link}`);
                return merged;
              },
              (err) => {
                console.log(`[ERROR] "${title}" err=${err.message} _fvsLink=${_fvsLink || "EMPTY"}`);
                return { ...listingExtra, title, date, content: "", link: _fvsLink || link, sourceUrl: link };
              }
            );
          })
        );
        allDetailResults.push(...batchResults);
        scrapedItems += batchResults.length;
        sendEvent("progress", {
          done: scrapedItems, total: totalItems, year: entry.year,
          message: `Scraped ${scrapedItems} of ${totalItems} (${entry.year})`,
          latest: batchResults.map((r) => r.title),
        });
      }
    }

    const output = buildOutput(analysis, allDetailResults, detailSelOverride || sel.detail, sel.listing.extra);
    sendEvent("done", { total: allDetailResults.length, data: output });
    res.end();
  } catch (err) {
    sendEvent("error", { message: err.message });
    res.end();
  }
});

app.post("/api/scrape-single", async (req, res) => {
  const { url, template, pageMode, loadMoreSelector, paginationNextSelector, selectors: customSel } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!template) return res.status(400).json({ error: "Sample JSON template is required" });

  const analysis = analyzeTemplate(template);
  if (!analysis) return res.status(400).json({ error: "Could not detect Sitemap structure in uploaded JSON" });

  let sel = mergeSelectors(customSel);
  const b = await getBrowser();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let detailSelOverride = null;
    const detailEmpty = !customSel || !customSel.detail || !Object.values(customSel.detail).some((v) => v);

    if (selectorsAreEmpty(customSel)) {
      sendEvent("status", { message: "No selectors provided. Auto-detecting..." });
      const detected = await autoDetectListingSelectors(b, url);
      if (detected) {
        sel = { listing: { itemRow: detected.itemRow, titleLink: detected.titleLink, date: detected.date, extra: detected.document ? { document: detected.document } : {} }, detail: sel.detail };
        sendEvent("status", { message: `Auto-detected: row=${detected.itemRow}, link=${detected.titleLink}, date=${detected.date}` });
        sendEvent("detected", { listing: sel.listing });
      }
    }

    if (detailEmpty && analysis.fieldValueSource) {
      const fvs = analysis.fieldValueSource;
      const DETAIL_FIELDS = new Set(["title", "date", "content"]);
      const hasAnySelector = Object.values(fvs).some((v) => v);
      if (hasAnySelector) {
        detailSelOverride = { ...fvs };
        for (const dk of Object.keys(detailSelOverride)) {
          if (dk.toLowerCase() === "link") delete detailSelOverride[dk];
        }
        const extraFvs = {};
        for (const [k, v] of Object.entries(fvs)) {
          const lower = k.toLowerCase();
          if (DETAIL_FIELDS.has(lower) || !v) continue;
          if (lower === "link") {
            extraFvs["_fvsLink"] = v;
          } else {
            extraFvs[k] = v;
          }
        }
        console.log(`[FVS-single] extraFvs=${JSON.stringify(extraFvs)} listing.extra before=${JSON.stringify(sel.listing.extra)}`);
        if (Object.keys(extraFvs).length > 0) {
          sel.listing.extra = { ...(sel.listing.extra || {}), ...extraFvs };
        }
        console.log(`[FVS-single] listing.extra after=${JSON.stringify(sel.listing.extra)}`);
        const selSummary = Object.entries(fvs).map(([k, v]) => `${k}=${v || "auto"}`).join(", ");
        sendEvent("status", { message: `Using Field Value Source selectors: ${selSummary}` });
        sendEvent("detected", { detail: detailSelOverride });
      }
    }

    let items = [];

    if (pageMode === "pagination") {
      const nextSel = paginationNextSelector || "a.next, a[rel='next'], .pagination .next a, li.next a";
      const allPages = await fetchAllPaginated(b, url, nextSel, sel.listing.itemRow, sendEvent);
      for (const html of allPages) {
        items.push(...extractItemsFromHtml(html, sel, url));
      }
    } else if (pageMode === "load-more") {
      const lmSel = loadMoreSelector || "button.load-more, a.load-more, .load-more button, [class*='load-more'], [class*='loadMore']";
      const result = await fetchAllLoadMore(b, url, lmSel, sel.listing.itemRow, sendEvent);
      if (result.apiItems) {
        items = result.apiItems;
      } else {
        items = extractItemsFromHtml(result.html, sel, url);
      }
    } else {
      sendEvent("status", { message: "Loading page..." });
      const html = await fetchPage(b, url);
      items = extractItemsFromHtml(html, sel, url);
    }

    if (items.length <= 20) {
      sendEvent("status", { message: `Found ${items.length} items in HTML. Checking for hidden API pagination...` });
      const apiInfo = await detectApiPagination(b, url, sendEvent);
      if (apiInfo) {
        const apiItems = await fetchAllApiPages(b, apiInfo, sendEvent);
        if (apiItems.length > items.length) {
          sendEvent("status", { message: `API found ${apiItems.length} items (vs ${items.length} in HTML). Using API data.` });
          items = apiItems;
        }
      }
    }

    const uniqueLinks = new Set();
    items = items.filter((it) => {
      if (uniqueLinks.has(it.link)) return false;
      uniqueLinks.add(it.link);
      return true;
    });

    sendEvent("status", { message: `Found ${items.length} unique press releases. Scraping details...` });

    if (!detailSelOverride && detailEmpty && items.length > 0) {
      sendEvent("status", { message: "Auto-detecting detail page selectors..." });
      const firstLink = items[0].link.startsWith("http") ? items[0].link : new URL(items[0].link, url).href;
      detailSelOverride = await autoDetectDetailSelectors(b, firstLink);
      if (detailSelOverride && analysis.fieldValueSource) {
        for (const key of Object.keys(analysis.fieldValueSource)) {
          if (detailSelOverride[key] === undefined) detailSelOverride[key] = "";
        }
      }
      if (detailSelOverride) {
        const selSummary = Object.entries(detailSelOverride).map(([k, v]) => `${k}=${v || "none"}`).join(", ");
        sendEvent("status", { message: `Detail auto-detected: ${selSummary}` });
        sendEvent("detected", { detail: detailSelOverride });
      }
    }

    const allDetailResults = [];
    const BATCH_SIZE = 3;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((item) => {
          const { title, date, link, _fvsLink, ...listingExtra } = item;
          console.log(`[BATCH-single] "${title}" navLink=${link} _fvsLink=${_fvsLink || "EMPTY"} extras=${JSON.stringify(Object.keys(listingExtra))}`);
          return scrapeDetailPage(b, link, sel, detailSelOverride, analysis.fieldTypeSpec, { title, date }).then(
            (detail) => {
              console.log(`[DETAIL-single] "${title}" detail.link=${detail.link} willReplace=${!!(_fvsLink && detail.link === link)}`);
              if (_fvsLink && detail.link === link) detail.link = _fvsLink;
              const merged = { ...listingExtra, ...detail };
              delete merged._fvsLink;
              console.log(`[MERGED-single] "${title}" link=${merged.link} desc=${(merged.description || "").substring(0,40)}`);
              return merged;
            },
            (err) => {
              console.log(`[ERROR-single] "${title}" err=${err.message} _fvsLink=${_fvsLink || "EMPTY"}`);
              return { ...listingExtra, title, date, content: "", link: _fvsLink || link, sourceUrl: link };
            }
          );
        })
      );
      allDetailResults.push(...batchResults);
      sendEvent("progress", {
        done: allDetailResults.length, total: items.length,
        message: `Scraped ${allDetailResults.length} of ${items.length}`,
        latest: batchResults.map((r) => r.title),
      });
    }

    const output = buildOutput(analysis, allDetailResults, detailSelOverride || sel.detail, sel.listing.extra);
    sendEvent("done", { total: allDetailResults.length, data: output });
    res.end();
  } catch (err) {
    sendEvent("error", { message: err.message });
    res.end();
  }
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
