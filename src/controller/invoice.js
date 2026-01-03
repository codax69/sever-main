import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import "dotenv/config";
import { ApiError } from "../utility/ApiError.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import Order from "../Model/order.js";
import Invoice from "../Model/invoice.js";
import Customer from "../Model/customer.js";
import Vegetable from "../Model/vegetable.js";

// ============= ADVANCED INVOICE SYSTEM WITH DSA =============
// =====================================================
// FILE: controllers/invoiceController.js
// =====================================================

const CONFIG = {
  pageSize: "A4",
  margin: 50,
  colors: {
    primary: "#000000",
    secondary: "#2d2d2d",
    text: "#555555",
    textLight: "#888888",
    border: "#cccccc",
  },
  font: {
    dir: path.join(process.cwd(), "font"),
    families: {
      trirong: ["Trirong-Bold", "Trirong-Regular"],
      poppins: [
        "Poppins-Bold",
        "Poppins-SemiBold",
        "Poppins-Medium",
        "Poppins-Regular",
      ],
      baloo: ["BalooBhai2-Regular", "BalooBhai2-Medium"],
    },
  },
};

// ================= FONT MANAGER =================
class FontManager {
  constructor(doc) {
    this.doc = doc;
    this.available = { trirong: true, poppins: true, baloo: true };
    this.registerFont();
  }

  registerFont() {
    if (!fs.existsSync(CONFIG.font.dir)) {
      console.warn("Font directory not found. Using system font.");
      return;
    }

    Object.entries(CONFIG.font.families).forEach(([family, font]) => {
      const registered = font.every((font) => {
        const fontPath = path.join(CONFIG.font.dir, `${font}.ttf`);
        if (fs.existsSync(fontPath)) {
          try {
            this.doc.registerFont(font, fontPath);
            return true;
          } catch (err) {
            console.warn(`Failed to register ${font}:`, err.message);
            return false;
          }
        }
        return false;
      });
      this.available[family] = registered;
    });
  }

  getFont(type) {
    const fontMap = {
      "logo-bold": this.available.trirong ? "Trirong-Bold" : "Helvetica-Bold",
      "logo-regular": this.available.trirong ? "Trirong-Regular" : "Helvetica",
      heading: this.available.poppins ? "Poppins-Bold" : "Helvetica-Bold",
      subheading: this.available.poppins
        ? "Poppins-SemiBold"
        : "Helvetica-Bold",
      body: this.available.poppins ? "Poppins-Regular" : "Helvetica",
      "body-medium": this.available.poppins ? "Poppins-Medium" : "Helvetica",
      small: this.available.baloo ? "BalooBhai2-Regular" : "Helvetica",
      "small-medium": this.available.baloo ? "BalooBhai2-Medium" : "Helvetica",
    };
    return fontMap[type] || "Helvetica";
  }
}
class InvoiceBuilder {
  constructor(doc, order, options = {}) {
    this.doc = doc;
    this.order = order;
    this.options = {
      includeLogo: true,
      includeUPIQR: true,
      currency: "INR",
      ...options,
    };
    this.fontManager = new FontManager(doc);
    
    // A5 dimensions: 420 x 595 points (148mm x 210mm)
    this.pageWidth = 420;
    this.pageHeight = 595;
    this.margin = 25; // Reduced from 30
    this.contentWidth = this.pageWidth - (this.margin * 2);
    this.yPos = this.margin;
    this.footerHeight = 25; // Reserved space for footer
    this.maxContentY = this.pageHeight - this.footerHeight - 10; // Max Y before footer
    
    this.colors = {
      primary: "#0e540b", // Green
      primaryDark: "#e57512ff", // Darker Yellow
      dark: "#000000", // Black
      text: "#333333", // Text Gray
      textLight: "#666666", // Light Gray
      border: "#e0e0e0", // Border Gray
      white: "#FFFFFF",
      tableHeader: "#0e540b", // Black Header
    };
    this.currencySymbol =
      this.options.currency === "INR" ? "Rs." : this.options.currency;
  }

  // Draw green accent bar at top
  drawTopAccent() {
    this.doc.rect(0, 0, this.pageWidth, 5).fill(this.colors.primary);
    this.yPos = 15;
  }

  // Compact header with logo and company info
  drawHeader() {
    const logoPath = path.join(process.cwd(), "font", "vegbazar.png");
    const hasLogo = fs.existsSync(logoPath);

    if (this.options.includeLogo && hasLogo) {
      this.doc.image(logoPath, this.margin, this.yPos, { width: 30, height: 30 });
    }

    // Company Name
    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(12)
      .fillColor(this.colors.dark)
      .text("Vegbazar", hasLogo ? this.margin + 38 : this.margin, this.yPos + 2);

    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.colors.textLight)
      .text(
        "Fresh Vegetables & Grocery Store",
        hasLogo ? this.margin + 38 : this.margin,
        this.yPos + 18
      );

    this.yPos += 38;
  }

  // Compact INVOICE title
  drawInvoiceTitle() {
    // Green accent bar
    this.doc.rect(this.margin, this.yPos, 80, 2).fill(this.colors.primary);

    this.yPos += 8;

    // INVOICE text
    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(16)
      .fillColor(this.colors.dark)
      .text("INVOICE", this.margin, this.yPos);

    // Green accent bar on right
    const rightBarX = this.pageWidth - this.margin - 80;
    this.doc.rect(rightBarX, this.yPos + 4, 80, 2).fill(this.colors.primary);

    this.yPos += 25;
  }

  // Compact two-column layout: Invoice To & Invoice Details
  drawInvoiceDetails() {
    const leftColumnX = this.margin;
    const rightColumnX = this.margin + 190;
    const startY = this.yPos;

    // LEFT COLUMN - Invoice To
    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.colors.dark)
      .text("Invoice to:", leftColumnX, startY);

    const customer = this.order.customerInfo || this.order.userId || {};

    this.doc
      .font(this.fontManager.getFont("subheading"))
      .fontSize(8)
      .fillColor(this.colors.dark)
      .text(customer.name || "N/A", leftColumnX, startY + 10);

    const addressParts = [
      customer.address,
      customer.area,
      customer.city,
      customer.state || "Gujarat",
    ].filter(Boolean);
    const addressText = addressParts.join(", ") || "Address not available";

    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.colors.textLight)
      .text(addressText, leftColumnX, startY + 22, { width: 170, lineGap: 0.5 });

    const addressHeight = this.doc.heightOfString(addressText, {
      width: 170,
      fontSize: 6,
    });

    // Phone & Email
    let detailY = startY + 27 + addressHeight;
    if (customer.mobile || customer.phone) {
      this.doc
        .fontSize(6)
        .fillColor(this.colors.textLight)
        .text(
          `Ph: ${customer.mobile || customer.phone}`,
          leftColumnX,
          detailY
        );
      detailY += 8;
    }

    if (customer.email) {
      this.doc
        .fontSize(6)
        .fillColor(this.colors.textLight)
        .text(`${customer.email}`, leftColumnX, detailY);
    }

    // RIGHT COLUMN - Invoice Details
    const details = [
      ["Invoice#", this.order.orderId || this.order._id],
      [
        "Date",
        new Date(
          this.order.orderDate || this.order.createdAt
        ).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }),
      ],
      ["Payment", this.order.paymentMethod || "COD"],
      ["Status", (this.order.orderStatus || "pending").toUpperCase()],
    ];

    details.forEach(([label, value], i) => {
      this.doc
        .font(this.fontManager.getFont("heading"))
        .fontSize(6)
        .fillColor(this.colors.dark)
        .text(label, rightColumnX, startY + i * 15);

      this.doc
        .font(this.fontManager.getFont("body"))
        .fontSize(6)
        .fillColor(this.colors.textLight)
        .text(value, rightColumnX + 45, startY + i * 15, {
          width: 120,
          align: "right",
        });
    });

    this.yPos = Math.max(startY + 70, detailY + 15);
  }

  // Compact table with black header
  drawItemsTable() {
    const tableWidth = this.contentWidth;
    const tableX = this.margin;
    const colWidths = {
      item: 170,
      price: 58,
      qty: 48,
      total: 74,
    };

    const drawTableHeader = () => {
      // Black header background
      this.doc
        .rect(tableX, this.yPos, tableWidth, 20)
        .fill(this.colors.tableHeader);

      // Header text (WHITE)
      const headerY = this.yPos + 6;
      this.doc
        .font(this.fontManager.getFont("heading"))
        .fontSize(6)
        .fillColor(this.colors.white)
        .text("Item Description", tableX + 4, headerY)
        .text("Price", tableX + colWidths.item + 4, headerY, {
          width: colWidths.price,
          align: "center",
        })
        .text("Qty.", tableX + colWidths.item + colWidths.price + 4, headerY, {
          width: colWidths.qty,
          align: "center",
        })
        .text("Total", tableX + tableWidth - colWidths.total - 4, headerY, {
          width: colWidths.total,
          align: "right",
        });

      this.yPos += 20;
    };

    drawTableHeader();

    let subtotal = 0;
    const items = this.order.selectedVegetables || this.order.items || [];

    items.forEach((item, index) => {
      // Get item name and clean it
      let itemName =
        item.vegetable?.name ||
        item.vegetableName ||
        item.name ||
        `Item ${index + 1}`;
      
      // Remove any leading numbers
      itemName = itemName
        .replace(/^\d+\.\s*/, '')
        .replace(/^\d+\s+/, '')
        .replace(/^[\d\s\.]+/, '')
        .trim();

      const qty = this.formatQuantity(item);
      const price = item.pricePerUnit || item.price || 0;
      const amount = item.subtotal || item.total || price * item.quantity || 0;
      subtotal += amount;

      const rowHeight = 22;
      const rowY = this.yPos;

      // Alternating row background
      if (index % 2 === 0) {
        this.doc.rect(tableX, rowY, tableWidth, rowHeight).fill("#f9f9f9");
      }

      // Row border
      this.doc
        .rect(tableX, rowY, tableWidth, rowHeight)
        .stroke(this.colors.border);

      // Item name
      this.doc
        .font(this.fontManager.getFont("body-medium"))
        .fontSize(6)
        .fillColor(this.colors.dark)
        .text(itemName, tableX + 4, rowY + 8, {
          width: colWidths.item - 8,
          ellipsis: true,
        });

      // Price
      this.doc
        .font(this.fontManager.getFont("body"))
        .fontSize(6)
        .fillColor(this.colors.text)
        .text(
          `Rs.${price.toFixed(2)}`,
          tableX + colWidths.item + 4,
          rowY + 8,
          {
            width: colWidths.price,
            align: "center",
          }
        );

      // Quantity
      this.doc
        .fontSize(6)
        .fillColor(this.colors.text)
        .text(qty, tableX + colWidths.item + colWidths.price + 4, rowY + 8, {
          width: colWidths.qty,
          align: "center",
        });

      // Total
      this.doc
        .font(this.fontManager.getFont("subheading"))
        .fontSize(7)
        .fillColor(this.colors.dark)
        .text(
          `Rs.${amount.toFixed(2)}`,
          tableX + tableWidth - colWidths.total - 4,
          rowY + 8,
          {
            width: colWidths.total,
            align: "right",
          }
        );

      this.yPos += rowHeight;
    });

    return subtotal;
  }

  formatQuantity(item) {
    // Handle set-based items
    if (item.setLabel) {
      return `${item.quantity} x ${item.setLabel}`;
    }

    // Handle weight-based items
    if (item.weight && item.weight !== "set0") {
      return `${item.quantity} x ${item.weight}`;
    }

    // Handle quantity with units
    return `${item.quantity} ${item.setUnit || item.unit || "pcs"}`;
  }

  // Compact totals section
  drawTotals(subtotal) {
    this.yPos += 10;

    const rightColumnX = this.pageWidth - this.margin - 140;
    const labelWidth = 70;
    const valueWidth = 70;

    // Thank you message (smaller)
    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.colors.dark)
      .text("Thank you for your business", this.margin, this.yPos);

    // Subtotal
    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(7)
      .fillColor(this.colors.text)
      .text("Sub Total:", rightColumnX, this.yPos, {
        width: labelWidth,
        align: "left",
      })
      .text(`Rs.${subtotal.toFixed(2)}`, rightColumnX + labelWidth, this.yPos, {
        width: valueWidth,
        align: "right",
      });

    this.yPos += 12;

    // Discount if applicable
    if (this.order.couponDiscount && this.order.couponDiscount > 0) {
      this.doc
        .font(this.fontManager.getFont("body"))
        .fontSize(6)
        .fillColor(this.colors.text)
        .text(`Discount:`, rightColumnX, this.yPos, {
          width: labelWidth,
          align: "left",
        })
        .text(
          `-Rs.${this.order.couponDiscount.toFixed(2)}`,
          rightColumnX + labelWidth,
          this.yPos,
          {
            width: valueWidth,
            align: "right",
          }
        );

      this.yPos += 12;
    }

    // Delivery charges
    const deliveryCharge = this.order.deliveryCharges || 0;
    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.colors.text)
      .text("Delivery:", rightColumnX, this.yPos, {
        width: labelWidth,
        align: "left",
      })
      .text(
        `Rs.${deliveryCharge.toFixed(2)}`,
        rightColumnX + labelWidth,
        this.yPos,
        {
          width: valueWidth,
          align: "right",
        }
      );

    this.yPos += 14;

    // Total with green background
    this.doc
      .rect(rightColumnX - 4, this.yPos - 4, labelWidth + valueWidth + 8, 20)
      .fill(this.colors.primary);

    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(9)
      .fillColor(this.colors.white)
      .text("Total:", rightColumnX, this.yPos + 2, {
        width: labelWidth,
        align: "left",
      })
      .fontSize(10)
      .text(
        `Rs.${this.order.totalAmount.toFixed(2)}`,
        rightColumnX + labelWidth,
        this.yPos + 2,
        {
          width: valueWidth,
          align: "right",
        }
      );

    this.yPos += 28;
  }

  // Compact Terms & Conditions
  drawTermsAndConditions() {
    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.colors.dark)
      .text("Terms & Conditions", this.margin, this.yPos);

    this.yPos += 8;

    const terms = [
      "Pay within 7 days. All vegetables subject to quality check. Returns within 24 hours for fresh produce.",
    ];

    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(5.5)
      .fillColor(this.colors.textLight);

    terms.forEach((term) => {
      this.doc.text(`• ${term}`, this.margin, this.yPos, { 
        width: this.contentWidth 
      });
      this.yPos += 8;
    });

    this.yPos += 5;
  }

  // Compact Payment Info
  drawPaymentInfo() {
    const leftColumnX = this.margin;

    this.doc
      .font(this.fontManager.getFont("heading"))
      .fontSize(7)
      .fillColor(this.colors.dark)
      .text("Payment Info:", leftColumnX, this.yPos);

    this.yPos += 8;

    const paymentDetails = [
      ["Account #:", "1234 5678 9012"],
      ["A/C Name:", "VegBazar"],
      ["Bank:", "HDFC Bank, Surat"],
      ["UPI ID:", "vegbazar@upi"],
    ];

    paymentDetails.forEach(([label, value]) => {
      this.doc
        .font(this.fontManager.getFont("body-medium"))
        .fontSize(5.5)
        .fillColor(this.colors.text)
        .text(label, leftColumnX, this.yPos, { continued: true })
        .font(this.fontManager.getFont("body"))
        .fillColor(this.colors.textLight)
        .text(`  ${value}`);
      this.yPos += 7;
    });

    this.yPos += 8;
  }

  // Compact footer
  drawFooter() {
    const footerY = this.pageHeight - 25;

    // Green accent bar
    this.doc.rect(this.margin, footerY, this.contentWidth, 2).fill(this.colors.primary);

    // Contact info
    this.doc
      .font(this.fontManager.getFont("body"))
      .fontSize(6)
      .fillColor(this.colors.textLight)
      .text(
        "Ph: +918780564115  |  Shop 102, Valsad, Gujarat",
        this.margin,
        footerY + 8,
        { align: "center", width: this.contentWidth }
      );
    
    this.doc
      .text(
        "info.vegbazar@gmail.com",
        this.margin,
        footerY + 16,
        { align: "center", width: this.contentWidth }
      );
  }

  async build() {
    this.drawTopAccent();
    this.drawHeader();
    this.drawInvoiceTitle();
    this.drawInvoiceDetails();
    const subtotal = this.drawItemsTable();
    this.drawTotals(subtotal);
    this.drawTermsAndConditions();
    this.drawPaymentInfo();
    this.drawFooter();
  }
}
// ============= INVOICE NUMBER GENERATOR =============
const generateInvoiceNumber = async () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  // Find the last invoice created today to get sequence number
  const startOfDay = new Date(date.setHours(0, 0, 0, 0));
  const endOfDay = new Date(date.setHours(23, 59, 59, 999));

  const lastInvoice = await Invoice.findOne({
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  }).sort({ createdAt: -1 });

  let sequence = 1;
  if (lastInvoice && lastInvoice.invoiceNumber) {
    // Extract sequence from last invoice number (format: INV-YYYYMM-XXX)
    const lastSequence = parseInt(lastInvoice.invoiceNumber.split("-").pop());
    sequence = isNaN(lastSequence) ? 1 : lastSequence + 1;
  }

  // Format: INV-YYYYMM-001
  return `INV-${year}${month}-${String(sequence).padStart(3, "0")}`;
};

// LRU Cache for invoice templates
class InvoiceCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

// Priority Queue for email processing
class EmailQueue {
  constructor() {
    this.queue = [];
  }

  enqueue(item) {
    this.queue.push(item);
  }

  dequeue() {
    return this.queue.shift();
  }

  isEmpty() {
    return this.queue.length === 0;
  }

  size() {
    return this.queue.length;
  }
}

// Global instances
const invoiceCache = new InvoiceCache();
const emailTemplateCache = new InvoiceCache(20); // Smaller cache for email templates
const emailQueue = new EmailQueue(); // Proper queue implementation

// Analytics tracking
const invoiceAnalytics = {
  totalProcessed: 0,
  totalEmailsSent: 0,
  averageProcessingTime: 0,
  errors: [],
  lastProcessedAt: null,
};

// Email transporter with connection pooling
const createEmailTransporter = () => {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    pool: true, // Enable connection pooling
    maxConnections: 5,
    maxMessages: 100,
  });
};

export const generateInvoicePDF = async (order, options = {}) => {
  try {
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
  } catch (err) {
    throw new Error(`Invoice generation failed: ${err.message}`);
  }
};
// Send Email with Invoice
export const sendInvoiceEmail = async (order, pdfPath, options = {}) => {
  try {
    const {
      emailType = "invoice",
      customSubject = null,
      customMessage = null,
      ccEmails = [],
      bccEmails = [],
    } = options;

    const customerEmail = order.customerInfo?.email || order.customer?.email;
    if (!customerEmail) {
      throw new ApiError(400, "Customer email not found");
    }

    // Create email transporter
    const transporter = createEmailTransporter();

    // Email templates based on type
    const emailTemplates = {
      invoice: {
        subject: `Your VegBazar Invoice - Order #${order.orderId}`,
        html: `
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

              <p>Please find your invoice attached to this email. If you have any questions about your order, feel free to contact us.</p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="#" style="background-color: #0e540b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">View Order Details</a>
              </div>

              <p>Best regards,<br>The VegBazar Team</p>
            </div>

            <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center; font-size: 12px;">
              <p>Phone: 9265318453 | Email: info.vegbazar@gmail.com</p>
              <p>Gujarat 380001</p>
            </div>
          </div>
        `,
      },
      orderConfirmation: {
        subject: `Order Confirmation - VegBazar Order #${order.orderId}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center;">
              <h1>VegBazar</h1>
              <p>Order Confirmation</p>
            </div>

            <div style="padding: 30px; background-color: #f8f9fa;">
              <h2 style="color: #0e540b;">Order Confirmed!</h2>
              <p>Dear ${order.customerInfo?.name || "Valued Customer"},</p>

              <p>Your order has been confirmed and is being prepared for delivery.</p>

              <div style="background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px;">
                <h3 style="margin-top: 0; color: #0e540b;">Order Summary</h3>
                <p><strong>Order ID:</strong> ${order.orderId}</p>
                <p><strong>Estimated Delivery:</strong> ${order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString("en-IN") : "Within 24 hours"}</p>
                <p><strong>Delivery Address:</strong> ${order.deliveryAddress || "As specified"}</p>
              </div>

              <p>You will receive another email with your invoice once the order is ready for delivery.</p>

              <p>Best regards,<br>The VegBazar Team</p>
            </div>
          </div>
        `,
      },
      deliveryUpdate: {
        subject: `Delivery Update - VegBazar Order #${order.orderId}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center;">
              <h1>VegBazar</h1>
              <p>Delivery Update</p>
            </div>

            <div style="padding: 30px; background-color: #f8f9fa;">
              <h2 style="color: #0e540b;">Your Order is Out for Delivery!</h2>
              <p>Dear ${order.customerInfo?.name || "Valued Customer"},</p>

              <p>Great news! Your order is now out for delivery.</p>

              <div style="background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px;">
                <h3 style="margin-top: 0; color: #0e540b;">Delivery Details</h3>
                <p><strong>Order ID:</strong> ${order.orderId}</p>
                <p><strong>Delivery Time:</strong> ${order.deliveryTime || "Within 2 hours"}</p>
                <p><strong>Delivery Address:</strong> ${order.deliveryAddress || "As specified"}</p>
              </div>

              <p>Please be available at the delivery address. Your invoice is attached for your reference.</p>

              <p>Best regards,<br>The VegBazar Team</p>
            </div>
          </div>
        `,
      },
    };

    const template = emailTemplates[emailType] || emailTemplates.invoice;
    const subject = customSubject || template.subject;
    const html = customMessage || template.html;

    // Email options
    const mailOptions = {
      from: {
        name: "VegBazar",
        address: process.env.EMAIL_USER,
      },
      to: customerEmail,
      subject: subject,
      html: html,
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

    // Add CC/BCC if provided
    if (ccEmails.length > 0) {
      mailOptions.cc = ccEmails;
    }
    if (bccEmails.length > 0) {
      mailOptions.bcc = bccEmails;
    }

    // Send email with retry logic
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(
          `Email sent successfully to ${customerEmail}: ${info.messageId}`
        );

        // Cache successful email template for future use
        const cacheKey = `email_template_${emailType}_${order.orderId}`;
        emailTemplateCache.set(cacheKey, { subject, html }, 3600000); // Cache for 1 hour

        return {
          success: true,
          messageId: info.messageId,
          email: customerEmail,
        };
      } catch (emailError) {
        attempts++;
        console.error(`Email attempt ${attempts} failed:`, emailError.message);

        if (attempts >= maxAttempts) {
          throw new ApiError(
            500,
            `Failed to send email after ${maxAttempts} attempts: ${emailError.message}`
          );
        }

        // Wait before retry (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempts) * 1000)
        );
      }
    }
  } catch (error) {
    console.error("Error in sendInvoiceEmail:", error);
    throw error;
  }
};

// Main function to generate and send invoice
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

    // Find the order with populated data
    const order = await Order.findOne({ _id: orderId })
      .populate("customerInfo", "name email mobile address city area state")
      .populate("selectedVegetables.vegetable", "name")
      .lean();

    if (!order) {
      throw new ApiError(404, "Order not found");
    }

    // Validate order data
    if (!order.customerInfo) {
      throw new ApiError(400, "Order missing customer information");
    }

    console.log(
      `Processing invoice for order: ${orderId} (Priority: ${priority})`
    );

    // Check if invoice already exists
    let invoice = await Invoice.findByOrderId(orderId);

    if (!invoice) {
      // Generate unique invoice number
      const invoiceNumber = await generateInvoiceNumber();

      // Create invoice record
      invoice = new Invoice({
        invoiceNumber: invoiceNumber,
        orderId: order._id,
        customerInfo: {
          name: order.customerInfo.name,
          email: order.customerInfo.email,
          phone: order.customerInfo.mobile,
          address: order.customerInfo.address,
          city: order.customerInfo.city,
          area: order.customerInfo.area,
          state: order.customerInfo.state,
        },
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
    }

    // Check cache for existing invoice PDF
    const cacheKey = `invoice_${orderId}`;
    let cachedInvoice = invoiceCache.get(cacheKey);

    if (
      cachedInvoice &&
      cachedInvoice.pdfPath &&
      fs.existsSync(cachedInvoice.pdfPath)
    ) {
      pdfPath = cachedInvoice.pdfPath;
      console.log(`Using cached invoice PDF for order: ${orderId}`);
    } else {
      // Generate PDF invoice with enhanced options
      const pdfOptions = {
        includeLogo: true,
        showPaymentStatus: true,
        currency: "INR",
      };

      pdfPath = await generateInvoicePDF(order, pdfOptions);
      console.log(`Invoice PDF generated: ${pdfPath}`);

      // Update invoice record with PDF path
      invoice.pdfPath = pdfPath;
      await invoice.save();

      // Cache the generated invoice
      invoiceCache.set(
        cacheKey,
        {
          pdfPath,
          generatedAt: Date.now(),
          orderId,
        },
        7200000
      ); // Cache for 2 hours
    }

    let emailResult = null;
    if (sendEmail) {
      try {
        // Send email with enhanced options
        emailResult = await sendInvoiceEmail(order, pdfPath, {
          emailType,
          ccEmails: options.ccEmails || [],
          bccEmails: options.bccEmails || [],
        });

        console.log(`Invoice email sent successfully to: ${emailResult.email}`);

        // Update invoice record if email sent successfully
        if (emailResult.success) {
          invoice.emailSent = true;
          invoice.emailSentAt = new Date();
          invoice.emailMessageId = emailResult.messageId;
          invoice.status = "sent";
          await invoice.save();

          // Update order status if not already delivered
          if (order.orderStatus !== "delivered") {
            await Order.findByIdAndUpdate(orderId, {
              orderStatus: "invoiced",
              invoiceSentAt: new Date(),
            });
          }
        }
      } catch (emailError) {
        console.error(
          `Email sending failed for order ${orderId}:`,
          emailError.message
        );

        // Don't fail the entire process if email fails
        emailResult = {
          success: false,
          error: emailError.message,
        };
      }
    }

    // Add to email queue for retry if email failed
    if (sendEmail && (!emailResult || !emailResult.success)) {
      emailQueue.enqueue({
        orderId,
        pdfPath,
        emailType,
        retryCount: 0,
        maxRetries: 3,
        priority: priority === "high" ? 1 : 2,
      });
    }

    const processingTime = Date.now() - startTime;

    // Analytics tracking
    if (includeAnalytics) {
      invoiceAnalytics.totalProcessed++;
      invoiceAnalytics.averageProcessingTime =
        (invoiceAnalytics.averageProcessingTime + processingTime) / 2;
      if (emailResult?.success) {
        invoiceAnalytics.totalEmailsSent++;
      }
      invoiceAnalytics.lastProcessedAt = new Date();
    }

    return {
      success: true,
      message: "Invoice processed successfully",
      orderId: orderId,
      emailSent: emailResult?.success || false,
      pdfPath,
      processingTime,
      emailResult,
      cached: cachedInvoice ? true : false,
    };
  } catch (error) {
    console.error("Error processing invoice:", error);

    // Clean up temporary files on error
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
      orderId: orderId,
      emailSent: false,
      processingTime: Date.now() - startTime,
      error: error.message,
    };
  }
};

// Enhanced API controller with multiple endpoints
export const invoiceController = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const {
    sendEmail = true,
    emailType = "invoice",
    priority = "normal",
  } = req.query;

  if (!orderId) {
    throw new ApiError(400, "Order ID is required");
  }

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

// Get invoice PDF without sending email
export const getInvoicePDF = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    throw new ApiError(400, "Order ID is required");
  }

  const order = await Order.findOne({ _id: orderId })
    .populate("customerInfo", "name email mobile address city area state")
    .populate("selectedVegetables.vegetable", "name")
    .lean();

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  // Check cache first
  const cacheKey = `invoice_${orderId}`;
  let pdfPath = invoiceCache.get(cacheKey)?.pdfPath;

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    // Generate new PDF
    pdfPath = await generateInvoicePDF(order, {
      includeLogo: true,
      showPaymentStatus: true,
      currency: "INR",
    });

    // Cache it
    invoiceCache.set(
      cacheKey,
      {
        pdfPath,
        generatedAt: Date.now(),
        orderId,
      },
      7200000
    );

    // Update or create invoice record
    let invoice = await Invoice.findByOrderId(orderId);
    if (!invoice) {
      const invoiceNumber = await generateInvoiceNumber();

      invoice = new Invoice({
        invoiceNumber: invoiceNumber,
        orderId: order._id,
        customerInfo: {
          name: order.customerInfo.name,
          email: order.customerInfo.email,
          phone: order.customerInfo.mobile,
          address: order.customerInfo.address,
          city: order.customerInfo.city,
          area: order.customerInfo.area,
          state: order.customerInfo.state,
        },
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
        pdfPath: pdfPath,
      });
      await invoice.save();
    } else {
      invoice.pdfPath = pdfPath;
      await invoice.save();
    }
  }

  // Stream PDF to response
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Invoice-${orderId}.pdf`
  );

  const fileStream = fs.createReadStream(pdfPath);
  fileStream.pipe(res);

  fileStream.on("error", (error) => {
    console.error("Error streaming PDF:", error);
    res.status(500).json(new ApiError(500, "Failed to stream PDF"));
  });
});

// Bulk invoice processing
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

  // Process invoices concurrently with limit
  const concurrencyLimit = 5;
  for (let i = 0; i < orderIds.length; i += concurrencyLimit) {
    const batch = orderIds.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map((orderId) =>
      processOrderInvoice(orderId, {
        ...options,
        includeAnalytics: false, // Disable per-invoice analytics for bulk
      })
    );

    const batchResults = await Promise.allSettled(batchPromises);
    results.push(
      ...batchResults.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : {
              success: false,
              message: result.reason?.message || "Unknown error",
              orderId: batch[batchResults.indexOf(result)],
              emailSent: false,
            }
      )
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
      "Bulk invoice processing completed"
    )
  );
});

// Get invoice analytics
export const getInvoiceAnalytics = asyncHandler(async (req, res) => {
  const analytics = {
    ...invoiceAnalytics,
    cacheStats: {
      size: invoiceCache.size(),
      maxSize: invoiceCache.maxSize,
    },
    emailQueueStats: {
      size: emailQueue.size(),
      isEmpty: emailQueue.isEmpty(),
    },
    templateCacheStats: {
      size: emailTemplateCache.size(),
      maxSize: emailTemplateCache.maxSize,
    },
  };

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        analytics,
        "Invoice analytics retrieved successfully"
      )
    );
});

// Retry failed emails
export const retryFailedEmails = asyncHandler(async (req, res) => {
  const { maxRetries = 3 } = req.query;
  const results = [];

  while (!emailQueue.isEmpty() && results.length < 10) {
    // Process max 10 at a time
    const emailJob = emailQueue.dequeue();

    if (emailJob.retryCount < maxRetries) {
      try {
        const order = await Order.findOne({ _id: emailJob.orderId })
          .populate("customerInfo", "name email mobile address city area state")
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
          emailQueue.enqueue(emailJob); // Re-queue for retry
        }

        results.push({
          orderId: emailJob.orderId,
          success: false,
          error: error.message,
          retryCount: emailJob.retryCount,
        });
      }
    }
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        processed: results.length,
        results,
      },
      "Email retry process completed"
    )
  );
});
