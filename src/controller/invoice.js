import PDFDocument from "pdfkit";
import { createTransport } from "nodemailer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { ApiError } from "../utility/ApiError.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import Order from "../Model/order.js";
import Invoice from "../Model/invoice.js";
import User from "../Model/user.js";

// ================= CONFIGURATION =================
const CONFIG = Object.freeze({
  pageSize: "A4",
  margin: 50,
  colors: Object.freeze({
    primary: "#0e540b",
    primaryDark: "#e57512ff",
    dark: "#000000",
    text: "#333333",
    textLight: "#666666",
    border: "#e0e0e0",
    white: "#FFFFFF",
    tableHeader: "#0e540b",
  }),
  font: {
    dir: path.join(process.cwd(), "font"),
    families: Object.freeze({
      trirong: ["Trirong-Bold", "Trirong-Regular"],
      poppins: [
        "Poppins-Bold",
        "Poppins-SemiBold",
        "Poppins-Medium",
        "Poppins-Regular",
      ],
      baloo: ["BalooBhai2-Regular", "BalooBhai2-Medium"],
    }),
  },
  email: {
    host: "smtp.gmail.com",
    port: 587,
    poolSize: 5,
    maxMessages: 100,
  },
  cache: {
    maxSize: 50,
    ttl: 7200000, // 2 hours
  },
  retry: {
    maxAttempts: 3,
    baseDelay: 1000,
  },
});

// ================= OPTIMIZED LRU CACHE WITH MAP =================
class LRUCache {
  #cache = new Map();
  #maxSize;

  constructor(maxSize = 50) {
    this.#maxSize = maxSize;
  }

  get(key) {
    if (!this.#cache.has(key)) return null;
    const value = this.#cache.get(key);
    // Move to end (most recently used)
    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.#cache.keys().next().value;
      this.#cache.delete(firstKey);
    }
    this.#cache.set(key, value);
  }

  clear() {
    this.#cache.clear();
  }

  size() {
    return this.#cache.size;
  }
}

// ================= PRIORITY QUEUE USING HEAP =================
class PriorityQueue {
  #heap = [];

  enqueue(item, priority = 2) {
    this.#heap.push({ item, priority });
    this.#bubbleUp(this.#heap.length - 1);
  }

  dequeue() {
    if (this.isEmpty()) return null;
    if (this.#heap.length === 1) return this.#heap.pop().item;

    const result = this.#heap[0];
    this.#heap[0] = this.#heap.pop();
    this.#bubbleDown(0);
    return result.item;
  }

  #bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.#heap[parentIndex].priority <= this.#heap[index].priority) break;
      [this.#heap[parentIndex], this.#heap[index]] = [
        this.#heap[index],
        this.#heap[parentIndex],
      ];
      index = parentIndex;
    }
  }

  #bubbleDown(index) {
    const length = this.#heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (
        left < length &&
        this.#heap[left].priority < this.#heap[smallest].priority
      ) {
        smallest = left;
      }
      if (
        right < length &&
        this.#heap[right].priority < this.#heap[smallest].priority
      ) {
        smallest = right;
      }
      if (smallest === index) break;

      [this.#heap[index], this.#heap[smallest]] = [
        this.#heap[smallest],
        this.#heap[index],
      ];
      index = smallest;
    }
  }

  isEmpty() {
    return this.#heap.length === 0;
  }

  size() {
    return this.#heap.length;
  }
}

// ================= FONT MANAGER (OPTIMIZED) =================
class FontManager {
  #doc;
  #available;
  #fontMap;

  constructor(doc) {
    this.#doc = doc;
    this.#available = new Map();
    this.#registerFonts();
    this.#buildFontMap();
  }

  #registerFonts() {
    if (!fs.existsSync(CONFIG.font.dir)) {
      console.warn("Font directory not found. Using system font.");
      return;
    }

    for (const [family, fonts] of Object.entries(CONFIG.font.families)) {
      const allRegistered = fonts.every((font) => {
        const fontPath = path.join(CONFIG.font.dir, `${font}.ttf`);
        if (!fs.existsSync(fontPath)) return false;

        try {
          this.#doc.registerFont(font, fontPath);
          return true;
        } catch (err) {
          console.warn(`Failed to register ${font}:`, err.message);
          return false;
        }
      });
      this.#available.set(family, allRegistered);
    }
  }

  #buildFontMap() {
    this.#fontMap = new Map([
      [
        "logo-bold",
        this.#available.get("trirong") ? "Trirong-Bold" : "Helvetica-Bold",
      ],
      [
        "logo-regular",
        this.#available.get("trirong") ? "Trirong-Regular" : "Helvetica",
      ],
      [
        "heading",
        this.#available.get("poppins") ? "Poppins-Bold" : "Helvetica-Bold",
      ],
      [
        "subheading",
        this.#available.get("poppins") ? "Poppins-SemiBold" : "Helvetica-Bold",
      ],
      [
        "body",
        this.#available.get("poppins") ? "Poppins-Regular" : "Helvetica",
      ],
      [
        "body-medium",
        this.#available.get("poppins") ? "Poppins-Medium" : "Helvetica",
      ],
      [
        "small",
        this.#available.get("baloo") ? "BalooBhai2-Regular" : "Helvetica",
      ],
      [
        "small-medium",
        this.#available.get("baloo") ? "BalooBhai2-Medium" : "Helvetica",
      ],
    ]);
  }

  getFont(type) {
    return this.#fontMap.get(type) || "Helvetica";
  }
}

// ================= INVOICE BUILDER (OPTIMIZED) =================
class InvoiceBuilder {
  #doc;
  #order;
  #options;
  #fontManager;
  #dimensions;
  #colors;
  #yPos;

  constructor(doc, order, options = {}) {
    this.#doc = doc;
    this.#order = order;
    this.#options = {
      includeLogo: true,
      includeUPIQR: true,
      currency: "INR",
      ...options,
    };
    this.#fontManager = new FontManager(doc);
    this.#dimensions = {
      pageWidth: 420,
      pageHeight: 595,
      margin: 25,
      contentWidth: 370,
      footerHeight: 25,
      maxContentY: 560,
    };
    this.#colors = CONFIG.colors;
    this.#yPos = this.#dimensions.margin;
  }

  #drawTopAccent() {
    this.#doc
      .rect(0, 0, this.#dimensions.pageWidth, 5)
      .fill(this.#colors.primary);
    this.#yPos = 15;
  }

  #drawHeader() {
    const logoPath = path.join(process.cwd(), "font", "vegbazar.png");
    const hasLogo = this.#options.includeLogo && fs.existsSync(logoPath);

    if (hasLogo) {
      this.#doc.image(logoPath, this.#dimensions.margin, this.#yPos, {
        width: 35,
        height: 35,
      });
    }

    const logoX = hasLogo
      ? this.#dimensions.margin + 40
      : this.#dimensions.margin;
    this.#doc
      .font(this.#fontManager.getFont("logo-bold"))
      .fontSize(12)
      .fillColor(this.#colors.primary)
      .text("Vegbazar", logoX, this.#yPos + 1);

    this.#doc
      .font(this.#fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.#colors.textLight)
      .text("Fresh Vegetables Store", logoX - 2, this.#yPos + 18);

    this.#yPos += 38;
  }

  #drawInvoiceTitle() {
    this.#doc
      .rect(this.#dimensions.margin, this.#yPos, 80, 2)
      .fill(this.#colors.primary);
    this.#yPos += 8;

    this.#doc
      .font(this.#fontManager.getFont("heading"))
      .fontSize(16)
      .fillColor(this.#colors.dark)
      .text("INVOICE", this.#dimensions.margin, this.#yPos);

    const rightBarX = this.#dimensions.pageWidth - this.#dimensions.margin - 80;
    this.#doc.rect(rightBarX, this.#yPos + 4, 80, 2).fill(this.#colors.primary);

    this.#yPos += 25;
  }

  #drawInvoiceDetails() {
    const leftColumnX = this.#dimensions.margin;
    const rightColumnX = this.#dimensions.margin + 190;
    const startY = this.#yPos;

    // Customer Info
    const customer = this.#order.customerInfo || this.#order.userId || {};
    this.#doc
      .font(this.#fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.#colors.dark)
      .text("Invoice to:", leftColumnX, startY);

    this.#doc
      .font(this.#fontManager.getFont("subheading"))
      .fontSize(8)
      .fillColor(this.#colors.dark)
      .text(customer.name || "N/A", leftColumnX, startY + 10);

    // Address
    const deliveryAddress = this.#order.deliveryAddressId || {};
    const addressParts = [
      deliveryAddress.street,
      deliveryAddress.area,
      deliveryAddress.city,
      deliveryAddress.state || "Gujarat",
      deliveryAddress.pincode,
    ].filter(Boolean);

    const addressText = addressParts.join(", ") || "Address not available";
    this.#doc
      .font(this.#fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.#colors.textLight)
      .text(addressText, leftColumnX, startY + 22, {
        width: 170,
        lineGap: 0.5,
      });

    const addressHeight = this.#doc.heightOfString(addressText, {
      width: 170,
      fontSize: 6,
    });
    let detailY = startY + 27 + addressHeight;

    if (customer.mobile || customer.phone) {
      this.#doc
        .fontSize(6)
        .text(`Ph: ${customer.mobile || customer.phone}`, leftColumnX, detailY);
      detailY += 8;
    }

    if (customer.email) {
      this.#doc.fontSize(6).text(customer.email, leftColumnX, detailY);
    }

    // Invoice Details (Right Column)
    const details = [
      ["Invoice#", this.#order.orderId || this.#order._id],
      [
        "Date",
        new Date(
          this.#order.orderDate || this.#order.createdAt,
        ).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }),
      ],
      ["Payment", this.#order.paymentMethod || "COD"],
      ["Status", (this.#order.orderStatus || "pending").toUpperCase()],
    ];

    details.forEach(([label, value], i) => {
      this.#doc
        .font(this.#fontManager.getFont("heading"))
        .fontSize(6)
        .fillColor(this.#colors.dark)
        .text(label, rightColumnX, startY + i * 15);

      this.#doc
        .font(this.#fontManager.getFont("body"))
        .fontSize(6)
        .fillColor(this.#colors.textLight)
        .text(value, rightColumnX + 45, startY + i * 15, {
          width: 120,
          align: "right",
        });
    });

    this.#yPos = Math.max(startY + 70, detailY + 15);
  }

  #drawItemsTable() {
    const tableWidth = this.#dimensions.contentWidth;
    const tableX = this.#dimensions.margin;
    const colWidths = { item: 170, price: 58, qty: 48, total: 74 };

    // Table Header
    this.#doc
      .rect(tableX, this.#yPos, tableWidth, 20)
      .fill(this.#colors.tableHeader);
    const headerY = this.#yPos + 6;

    const headers = [
      { text: "Item Description", x: tableX + 4, width: colWidths.item },
      { text: "Price", x: tableX + colWidths.item + 4, width: colWidths.price },
      {
        text: "Qty.",
        x: tableX + colWidths.item + colWidths.price + 4,
        width: colWidths.qty,
      },
      {
        text: "Total",
        x: tableX + tableWidth - colWidths.total - 4,
        width: colWidths.total,
      },
    ];

    this.#doc
      .font(this.#fontManager.getFont("heading"))
      .fontSize(6)
      .fillColor(this.#colors.white);

    headers.forEach(({ text, x, width }) => {
      this.#doc.text(text, x, headerY, {
        width,
        align: width === colWidths.item ? "left" : "center",
      });
    });

    this.#yPos += 20;

    // Table Rows
    let subtotal = 0;
    const items = this.#order.selectedVegetables || this.#order.items || [];

    items.forEach((item, index) => {
      const itemName = this.#cleanItemName(item, index);
      const qty = this.#formatQuantity(item);
      const price = item.pricePerUnit || item.price || 0;
      const amount = item.subtotal || item.total || price * item.quantity || 0;
      subtotal += amount;

      const rowHeight = 22;
      const rowY = this.#yPos;

      // Alternating row background
      if (index % 2 === 0) {
        this.#doc.rect(tableX, rowY, tableWidth, rowHeight).fill("#f9f9f9");
      }

      this.#doc
        .rect(tableX, rowY, tableWidth, rowHeight)
        .stroke(this.#colors.border);

      // Row content
      this.#doc
        .font(this.#fontManager.getFont("body-medium"))
        .fontSize(6)
        .fillColor(this.#colors.dark)
        .text(itemName, tableX + 4, rowY + 8, {
          width: colWidths.item - 8,
          ellipsis: true,
        });

      this.#doc
        .font(this.#fontManager.getFont("body"))
        .fontSize(6)
        .fillColor(this.#colors.text)
        .text(`Rs.${price.toFixed(2)}`, tableX + colWidths.item + 4, rowY + 8, {
          width: colWidths.price,
          align: "center",
        });

      this.#doc.text(
        qty,
        tableX + colWidths.item + colWidths.price + 4,
        rowY + 8,
        {
          width: colWidths.qty,
          align: "center",
        },
      );

      this.#doc
        .font(this.#fontManager.getFont("subheading"))
        .fontSize(7)
        .fillColor(this.#colors.dark)
        .text(
          `Rs.${amount.toFixed(2)}`,
          tableX + tableWidth - colWidths.total - 4,
          rowY + 8,
          {
            width: colWidths.total,
            align: "right",
          },
        );

      this.#yPos += rowHeight;
    });

    return subtotal;
  }

  #cleanItemName(item, index) {
    let name =
      item.vegetable?.name ||
      item.vegetableName ||
      item.name ||
      `Item ${index + 1}`;
    return name
      .replace(/^\d+\.\s*/, "")
      .replace(/^\d+\s+/, "")
      .replace(/^[\d\s\.]+/, "")
      .trim();
  }

  #formatQuantity(item) {
    if (item.setLabel) return `${item.quantity} x ${item.setLabel}`;
    if (item.weight && item.weight !== "set0")
      return `${item.quantity} x ${item.weight}`;
    return `${item.quantity} ${item.setUnit || item.unit || "pcs"}`;
  }

  #drawTotals(subtotal) {
    this.#yPos += 10;
    const rightColumnX =
      this.#dimensions.pageWidth - this.#dimensions.margin - 140;
    const labelWidth = 70;
    const valueWidth = 70;

    this.#doc
      .font(this.#fontManager.getFont("subheading"))
      .fontSize(7)
      .fillColor(this.#colors.dark)
      .text("Thank you for your business", this.#dimensions.margin, this.#yPos);

    // Subtotal
    this.#drawTotalLine(
      "Sub Total:",
      subtotal,
      rightColumnX,
      labelWidth,
      valueWidth,
    );
    this.#yPos += 12;

    // Discount
    if (this.#order.couponDiscount && this.#order.couponDiscount > 0) {
      this.#drawTotalLine(
        "Discount:",
        -this.#order.couponDiscount,
        rightColumnX,
        labelWidth,
        valueWidth,
      );
      this.#yPos += 12;
    }

    // Delivery
    this.#drawTotalLine(
      "Delivery:",
      this.#order.deliveryCharges || 0,
      rightColumnX,
      labelWidth,
      valueWidth,
      6,
    );
    this.#yPos += 14;

    // Grand Total
    this.#doc
      .rect(rightColumnX - 4, this.#yPos - 4, labelWidth + valueWidth + 8, 20)
      .fill(this.#colors.primary);

    this.#doc
      .font(this.#fontManager.getFont("heading"))
      .fontSize(9)
      .fillColor(this.#colors.white)
      .text("Total:", rightColumnX, this.#yPos + 2, {
        width: labelWidth,
        align: "left",
      })
      .fontSize(10)
      .text(
        `Rs.${this.#order.totalAmount.toFixed(2)}`,
        rightColumnX + labelWidth,
        this.#yPos + 2,
        {
          width: valueWidth,
          align: "right",
        },
      );

    this.#yPos += 28;
  }

  #drawTotalLine(label, amount, x, labelWidth, valueWidth, fontSize = 7) {
    this.#doc
      .font(this.#fontManager.getFont("body"))
      .fontSize(fontSize)
      .fillColor(this.#colors.text)
      .text(label, x, this.#yPos, { width: labelWidth, align: "left" })
      .text(
        `${amount < 0 ? "-" : ""}Rs.${Math.abs(amount).toFixed(2)}`,
        x + labelWidth,
        this.#yPos,
        {
          width: valueWidth,
          align: "right",
        },
      );
  }

  #drawTermsAndConditions() {
    this.#doc
      .font(this.#fontManager.getFont("subheading"))
      .fontSize(7)
      .fillColor(this.#colors.dark)
      .text("Terms & Conditions", this.#dimensions.margin, this.#yPos);

    this.#yPos += 8;

    const terms = [
      "Order confirmed after customer approval; cancellation not allowed once processing starts.",
      "Prices are based on daily market rates; minor weight variation may occur.",
      "Quality issues must be reported within 2 hours of delivery with proof.",
      "Delivery timing is best-effort; customer availability is required.",
      "This is a system-generated invoice and does not require a signature.",
      "3rd order gets FREE delivery or a special discount — our way of saying thank you.",
    ];

    this.#doc
      .font(this.#fontManager.getFont("body"))
      .fontSize(5.5)
      .fillColor(this.#colors.textLight);

    terms.forEach((term) => {
      this.#doc.text(`• ${term}`, this.#dimensions.margin, this.#yPos, {
        width: this.#dimensions.contentWidth,
      });
      this.#yPos += 8;
    });

    this.#yPos += 5;
  }

  #drawPaymentInfo() {
    this.#doc
      .font(this.#fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.#colors.dark)
      .text("Payment Info:", this.#dimensions.margin, this.#yPos);

    this.#yPos += 8;

    this.#doc
      .font(this.#fontManager.getFont("body-medium"))
      .fontSize(5.5)
      .fillColor(this.#colors.text)
      .text("UPI ID:", this.#dimensions.margin, this.#yPos, { continued: true })
      .font(this.#fontManager.getFont("body"))
      .fillColor(this.#colors.textLight)
      .text("  9265318453@upi");

    this.#yPos += 15;
  }

  #drawFooter() {
    const footerY = this.#dimensions.pageHeight - 25;
    this.#doc
      .rect(this.#dimensions.margin, footerY, this.#dimensions.contentWidth, 2)
      .fill(this.#colors.primary);

    this.#doc
      .font(this.#fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.#colors.textLight)
      .text(
        "Ph: +918780564115  |  Shop 102, Pushakar Villa, vashiyar velly, Valsad, Gujarat",
        this.#dimensions.margin,
        footerY + 8,
        { align: "center", width: this.#dimensions.contentWidth },
      )
      .text("info.vegbazar@gmail.com", this.#dimensions.margin, footerY + 16, {
        align: "center",
        width: this.#dimensions.contentWidth,
      });
  }

  async build() {
    this.#drawTopAccent();
    this.#drawHeader();
    this.#drawInvoiceTitle();
    this.#drawInvoiceDetails();
    const subtotal = this.#drawItemsTable();
    this.#drawTotals(subtotal);
    this.#drawTermsAndConditions();
    this.#drawPaymentInfo();
    this.#drawFooter();
  }
}

// ================= INVOICE NUMBER GENERATOR (OPTIMIZED) =================
const generateInvoiceNumber = async (retries = 3) => {
  const date = new Date();
  const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Find highest sequence number for this month
      const lastInvoice = await Invoice.findOne({
        invoiceNumber: new RegExp(`^INV-${yearMonth}-`),
      })
        .sort({ invoiceNumber: -1 })
        .select("invoiceNumber")
        .lean();

      let sequence = 1;
      if (lastInvoice?.invoiceNumber) {
        const parts = lastInvoice.invoiceNumber.split("-");
        if (parts.length === 3) {
          const lastSequence = parseInt(parts[2], 10);
          if (!isNaN(lastSequence)) sequence = lastSequence + 1;
        }
      }

      const invoiceNumber = `INV-${yearMonth}-${String(sequence).padStart(3, "0")}`;

      // Verify uniqueness
      const exists = await Invoice.exists({ invoiceNumber });
      if (!exists) return invoiceNumber;

      // If exists, retry
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    } catch (error) {
      console.error(
        `Invoice number generation attempt ${attempt + 1} failed:`,
        error.message,
      );
      if (attempt === retries - 1) {
        // Fallback to timestamp
        const timestamp = Date.now().toString().slice(-6);
        return `INV-${yearMonth}-${timestamp}`;
      }
    }
  }
};

// ================= GLOBAL INSTANCES =================
const invoiceCache = new LRUCache(CONFIG.cache.maxSize);
const emailTemplateCache = new LRUCache(20);
const emailQueue = new PriorityQueue();

// Analytics
const analytics = {
  totalProcessed: 0,
  totalEmailsSent: 0,
  averageProcessingTime: 0,
  errors: [],
  lastProcessedAt: null,
};

// Email transporter singleton
let emailTransporter = null;
const getEmailTransporter = () => {
  if (!emailTransporter) {
    emailTransporter = createTransport({
      host: CONFIG.email.host,
      port: CONFIG.email.port,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      pool: true,
      maxConnections: CONFIG.email.poolSize,
      maxMessages: CONFIG.email.maxMessages,
    });
  }
  return emailTransporter;
};

// ================= PDF GENERATION =================
export const generateInvoicePDF = async (order, options = {}) => {
  const fileName = `invoice-${order.orderId}-${Date.now()}.pdf`;
  const tempDir = path.join(process.cwd(), "temp");
  const filePath = path.join(tempDir, fileName);

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const doc = new PDFDocument({
    size: CONFIG.pageSize,
    margin: CONFIG.margin,
    info: {
      Title: `Invoice ${order.orderId}`,
      Author: "VegBazar",
    },
  });

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const builder = new InvoiceBuilder(doc, order, options);
  await builder.build();

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
};

// ================= EMAIL SENDING (OPTIMIZED) =================
export const sendInvoiceEmail = async (order, pdfPath, options = {}) => {
  const {
    emailType = "invoice",
    customSubject,
    customMessage,
    ccEmails = [],
    bccEmails = [],
  } = options;

  const customerEmail = order.customerInfo?.email || order.customer?.email;
  if (!customerEmail) throw new ApiError(400, "Customer email not found");

  const transporter = getEmailTransporter();

  const subject =
    customSubject || `Your VegBazar Invoice - Order #${order.orderId}`;
  const html =
    customMessage ||
    `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center;">
        <h1>VegBazar</h1>
        <p>Fresh Vegetables & Grocery Store</p>
      </div>
      <div style="padding: 30px; background-color: #f8f9fa;">
        <h2 style="color: #0e540b;">Your Order Invoice</h2>
        <p>Dear ${order.customerInfo?.name || "Valued Customer"},</p>
        <p>Thank you for shopping with VegBazar! Your order has been processed successfully.</p>
        <div style="background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #0e540b;">
          <h3 style="margin-top: 0; color: #0e540b;">Order Details</h3>
          <p><strong>Order ID:</strong> ${order.orderId}</p>
          <p><strong>Order Date:</strong> ${new Date(order.createdAt || order.orderDate).toLocaleDateString("en-IN")}</p>
          <p><strong>Total Amount:</strong> ₹${(order.totalAmount || 0).toFixed(2)}</p>
          <p><strong>Status:</strong> ${order.orderStatus || "Processing"}</p>
        </div>
        <p>Please find your invoice attached to this email.</p>
        <p>Best regards,<br>The VegBazar Team</p>
      </div>
      <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center; font-size: 12px;">
        <p>Phone: 9265318453 | Email: info.vegbazar@gmail.com</p>
        <p>Gujarat 380001</p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: { name: "VegBazar", address: process.env.EMAIL_USER },
    to: customerEmail,
    subject,
    html,
    attachments: pdfPath
      ? [
          {
            filename: `Invoice-${order.orderId}.pdf`,
            path: pdfPath,
            contentType: "application/pdf",
          },
        ]
      : [],
  };

  if (ccEmails.length > 0) mailOptions.cc = ccEmails;
  if (bccEmails.length > 0) mailOptions.bcc = bccEmails;

  // Retry logic with exponential backoff
  for (let attempt = 0; attempt < CONFIG.retry.maxAttempts; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return { success: true, messageId: info.messageId, email: customerEmail };
    } catch (emailError) {
      if (attempt === CONFIG.retry.maxAttempts - 1) {
        throw new ApiError(
          500,
          `Failed to send email after ${CONFIG.retry.maxAttempts} attempts: ${emailError.message}`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.retry.baseDelay * Math.pow(2, attempt)),
      );
    }
  }
};

// ================= MAIN PROCESSING FUNCTION =================
export const processOrderInvoice = async (orderId, options = {}) => {
  const startTime = Date.now();
  let pdfPath = null;

  try {
    const {
      sendEmail = true,
      emailType = "invoice",
      includeAnalytics = false,
      priority = "normal",
    } = options;

    // Fetch order with minimal fields
    const order = await Order.findOne({ _id: orderId })
      .populate({
        path: "customerInfo",
        select: "name username email mobile phone",
        model: User,
      })
      .populate("deliveryAddressId")
      .populate("selectedVegetables.vegetable", "name")
      .lean();

    if (!order) throw new ApiError(404, "Order not found");
    if (!order.customerInfo)
      throw new ApiError(400, "Order missing customer information");

    // Normalize customer info
    if (order.customerInfo) {
      order.customerInfo.name =
        order.customerInfo.name || order.customerInfo.username;
      order.customerInfo.mobile =
        order.customerInfo.mobile || order.customerInfo.phone;
    }

    // Check/create invoice
    let invoice = await Invoice.findOne({ orderId: order._id })
      .populate("deliveryAddress")
      .lean();

    if (!invoice) {
      const invoiceNumber = await generateInvoiceNumber();

      invoice = new Invoice({
        invoiceNumber,
        orderId: order._id,
        customerInfo: {
          name: order.customerInfo.name,
          email: order.customerInfo.email,
          phone: order.customerInfo.mobile,
        },
        deliveryAddress: order.deliveryAddress?._id,
        items: order.selectedVegetables.map((item) => ({
          vegetable: item.vegetable?._id,
          vegetableName: item.vegetable?.name || "Unknown Item",
          weight: item.weight,
          quantity: item.quantity,
          pricePerUnit: item.pricePerUnit,
          subtotal: item.subtotal,
          setLabel: item.setLabel,
          unit: item.setUnit,
        })),
        pricing: {
          subtotal: order.vegetablesTotal || 0,
          couponDiscount: order.couponDiscount || 0,
          deliveryCharges: order.deliveryCharges || 0,
          totalAmount: order.totalAmount,
          currency: "INR",
        },
        payment: {
          method: order.paymentMethod,
          status: order.paymentStatus,
          razorpayOrderId: order.razorpayOrderId,
          razorpayPaymentId: order.razorpayPaymentId,
        },
      });

      await invoice.save();
    } else {
      invoice = await Invoice.findOne({ _id: invoice._id });
    }

    // Check cache
    const cacheKey = `invoice_${orderId}`;
    const cachedInvoice = invoiceCache.get(cacheKey);

    if (cachedInvoice?.pdfPath && fs.existsSync(cachedInvoice.pdfPath)) {
      pdfPath = cachedInvoice.pdfPath;
    } else {
      pdfPath = await generateInvoicePDF(order, {
        includeLogo: true,
        showPaymentStatus: true,
        currency: "INR",
      });
      invoice.pdfPath = pdfPath;
      await invoice.save();
      invoiceCache.set(cacheKey, { pdfPath, generatedAt: Date.now(), orderId });
    }

    // Send email
    let emailResult = null;
    if (sendEmail) {
      try {
        emailResult = await sendInvoiceEmail(order, pdfPath, {
          emailType,
          ccEmails: options.ccEmails || [],
          bccEmails: options.bccEmails || [],
        });

        if (emailResult.success) {
          invoice.emailSent = true;
          invoice.emailSentAt = new Date();
          invoice.emailMessageId = emailResult.messageId;
          invoice.status = "sent";
          await invoice.save();

          if (order.orderStatus !== "delivered") {
            await Order.findByIdAndUpdate(orderId, {
              orderStatus: "placed",
              invoiceSentAt: new Date(),
            });
          }
        }
      } catch (emailError) {
        console.error(
          `Email sending failed for order ${orderId}:`,
          emailError.message,
        );
        emailResult = { success: false, error: emailError.message };
      }
    }

    // Queue failed emails
    if (sendEmail && (!emailResult || !emailResult.success)) {
      emailQueue.enqueue(
        {
          orderId,
          pdfPath,
          emailType,
          retryCount: 0,
          maxRetries: 3,
        },
        priority === "high" ? 1 : 2,
      );
    }

    const processingTime = Date.now() - startTime;

    // Update analytics
    if (includeAnalytics) {
      analytics.totalProcessed++;
      analytics.averageProcessingTime =
        (analytics.averageProcessingTime + processingTime) / 2;
      if (emailResult?.success) analytics.totalEmailsSent++;
      analytics.lastProcessedAt = new Date();
    }

    return {
      success: true,
      message: "Invoice processed successfully",
      orderId,
      emailSent: emailResult?.success || false,
      pdfPath,
      processingTime,
      emailResult,
      cached: !!cachedInvoice,
    };
  } catch (error) {
    console.error("Error processing invoice:", error);

    if (pdfPath && fs.existsSync(pdfPath) && !pdfPath.includes("cache")) {
      try {
        fs.unlinkSync(pdfPath);
      } catch (cleanupError) {
        console.error("Failed to cleanup temporary file:", cleanupError);
      }
    }

    return {
      success: false,
      message: error.message || "Failed to process invoice",
      orderId,
      emailSent: false,
      processingTime: Date.now() - startTime,
      error: error.message,
    };
  }
};

// ================= API CONTROLLERS =================
export const invoiceController = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const {
    sendEmail = true,
    emailType = "invoice",
    priority = "normal",
  } = req.query;

  if (!orderId) throw new ApiError(400, "Order ID is required");

  const result = await processOrderInvoice(orderId, {
    sendEmail: sendEmail === "true",
    emailType,
    priority,
    includeAnalytics: true,
  });

  if (result.success) {
    res
      .status(200)
      .json(new ApiResponse(200, result, "Invoice processed successfully"));
  } else {
    res.status(400).json(new ApiError(400, result.message));
  }
});

export const getInvoicePDF = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!orderId) throw new ApiError(400, "Order ID is required");

  const order = await Order.findOne({ _id: orderId })
    .populate("customerInfo", "name email mobile address city area state")
    .populate("selectedVegetables.vegetable", "name")
    .lean();

  if (!order) throw new ApiError(404, "Order not found");

  const cacheKey = `invoice_${orderId}`;
  let pdfPath = invoiceCache.get(cacheKey)?.pdfPath;

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    pdfPath = await generateInvoicePDF(order, {
      includeLogo: true,
      showPaymentStatus: true,
      currency: "INR",
    });
    invoiceCache.set(cacheKey, { pdfPath, generatedAt: Date.now(), orderId });

    let invoice = await Invoice.findOne({ orderId: order._id });
    if (!invoice) {
      const invoiceNumber = await generateInvoiceNumber();
      invoice = new Invoice({
        invoiceNumber,
        orderId: order._id,
        customerInfo: {
          name: order.customerInfo.name,
          email: order.customerInfo.email,
          phone: order.customerInfo.mobile,
        },
        deliveryAddress: order.deliveryAddress?._id,
        items: order.selectedVegetables.map((item) => ({
          vegetable: item.vegetable?._id,
          vegetableName: item.vegetable?.name || "Unknown Item",
          weight: item.weight,
          quantity: item.quantity,
          pricePerUnit: item.pricePerUnit,
          subtotal: item.subtotal,
          setLabel: item.setLabel,
          unit: item.setUnit,
        })),
        pricing: {
          subtotal: order.vegetablesTotal || 0,
          couponDiscount: order.couponDiscount || 0,
          deliveryCharges: order.deliveryCharges || 0,
          totalAmount: order.totalAmount,
          currency: "INR",
        },
        payment: {
          method: order.paymentMethod,
          status: order.paymentStatus,
          razorpayOrderId: order.razorpayOrderId,
          razorpayPaymentId: order.razorpayPaymentId,
        },
        pdfPath,
      });
      await invoice.save();
    } else {
      invoice.pdfPath = pdfPath;
      await invoice.save();
    }
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Invoice-${orderId}.pdf`,
  );

  const fileStream = fs.createReadStream(pdfPath);
  fileStream.pipe(res);
  fileStream.on("error", (error) => {
    console.error("Error streaming PDF:", error);
    res.status(500).json(new ApiError(500, "Failed to stream PDF"));
  });
});

export const bulkProcessInvoices = asyncHandler(async (req, res) => {
  const { orderIds, options = {} } = req.body;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new ApiError(400, "Order IDs array is required");
  }

  if (orderIds.length > 50) {
    throw new ApiError(400, "Maximum 50 orders can be processed at once");
  }

  const results = [];
  const startTime = Date.now();
  const concurrencyLimit = 5;

  for (let i = 0; i < orderIds.length; i += concurrencyLimit) {
    const batch = orderIds.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map((orderId) =>
      processOrderInvoice(orderId, { ...options, includeAnalytics: false }),
    );
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(
      ...batchResults.map((result, idx) =>
        result.status === "fulfilled"
          ? result.value
          : {
              success: false,
              message: result.reason?.message || "Unknown error",
              orderId: batch[idx],
              emailSent: false,
            },
      ),
    );
  }

  const totalTime = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;
  const emailSuccessCount = results.filter((r) => r.emailSent).length;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        results,
        summary: {
          total: orderIds.length,
          successful: successCount,
          failed: orderIds.length - successCount,
          emailsSent: emailSuccessCount,
          totalTime,
          averageTime: totalTime / orderIds.length,
        },
      },
      "Bulk invoice processing completed",
    ),
  );
});

export const getInvoiceAnalytics = asyncHandler(async (req, res) => {
  res.status(200).json(
    new ApiResponse(
      200,
      {
        ...analytics,
        cacheStats: {
          size: invoiceCache.size(),
          maxSize: CONFIG.cache.maxSize,
        },
        emailQueueStats: {
          size: emailQueue.size(),
          isEmpty: emailQueue.isEmpty(),
        },
        templateCacheStats: { size: emailTemplateCache.size(), maxSize: 20 },
      },
      "Invoice analytics retrieved successfully",
    ),
  );
});

export const retryFailedEmails = asyncHandler(async (req, res) => {
  const { maxRetries = 3 } = req.query;
  const results = [];

  while (!emailQueue.isEmpty() && results.length < 10) {
    const emailJob = emailQueue.dequeue();
    if (!emailJob || emailJob.retryCount >= maxRetries) continue;

    try {
      const order = await Order.findOne({ _id: emailJob.orderId })
        .populate("customerInfo", "name email mobile")
        .populate("deliveryAddress")
        .lean();

      if (order) {
        const emailResult = await sendInvoiceEmail(order, emailJob.pdfPath, {
          emailType: emailJob.emailType,
        });
        results.push({
          orderId: emailJob.orderId,
          success: true,
          messageId: emailResult.messageId,
        });
      } else {
        results.push({
          orderId: emailJob.orderId,
          success: false,
          error: "Order not found",
        });
      }
    } catch (error) {
      emailJob.retryCount++;
      if (emailJob.retryCount < maxRetries) {
        emailQueue.enqueue(emailJob, emailJob.priority || 2);
      }
      results.push({
        orderId: emailJob.orderId,
        success: false,
        error: error.message,
        retryCount: emailJob.retryCount,
      });
    }
  }

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { processed: results.length, results },
        "Email retry process completed",
      ),
    );
});
