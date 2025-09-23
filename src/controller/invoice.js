import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import 'dotenv/config';

const createEmailTransporter = () => {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587, 
    secure: false, 
    auth: {
      user: process.env.MAILER_MAIL, 
      pass: process.env.MAILER_PASSWORD, 
    },
  });
};

export const generateInvoicePDF = async (order) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const fileName = `invoice-${order.orderId}.pdf`;
      const filePath = path.join(process.cwd(), "temp", fileName);

      // Ensure temp directory exists
      if (!fs.existsSync(path.join(process.cwd(), "temp"))) {
        fs.mkdirSync(path.join(process.cwd(), "temp"), { recursive: true });
      }

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header
      doc
        .font("Helvetica-Bold")
        .fontSize(22)
        .text("INVOICE", { align: "center" });

      doc
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("VegBazar", { align: "center" })
        .font("Helvetica")
        .fontSize(12)
        .text("Gujarat 380001", { align: "center" })
        .text("Phone: 9265318453 | Email: info.vegbazar@gmail.com", { align: "center" })
        .moveDown(2);

      // Invoice details
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(`Invoice #: ${order.orderId}`)
        .text(`Date: ${new Date(order.orderDate).toLocaleDateString()}`)
        .moveDown();

      // Customer info
      doc
        .font("Helvetica-Bold")
        .text("Bill To:")
        .font("Helvetica")
        .text(order.customerInfo.name)
        .text(order.customerInfo.email)
        .text(order.customerInfo.address)
        .text(order.customerInfo.mobile)
        .moveDown(1);

      // Selected Offer
      if (order.selectedOffer && Object.keys(order.selectedOffer).length > 0) {
        doc
          .font("Helvetica-Bold")
          .text("Special Offer:")
          .font("Helvetica")
          .text(`${order.selectedOffer.title} - ₹${order.selectedOffer.price}`, { indent: 20 })
          .moveDown();
      }

      // Table Header
      const tableTop = doc.y + 10;
      doc
        .font("Helvetica-Bold")
        .text("Item", 50, tableTop)
        .text("Qty", 200, tableTop)
        .text("Price", 280, tableTop)
        .text("Total", 350, tableTop);

      doc.moveTo(50, tableTop + 15).lineTo(450, tableTop + 15).stroke();

      // Table Content
      let yPosition = tableTop + 30;
      let subtotal = 0;

      order.selectedVegetables.forEach((vegetable) => {
        const qty = 1; // default 1 per item
        const price = order.totalAmount; // price per item
        const itemTotal = qty * price;
        subtotal += itemTotal;

        doc
          .font("Helvetica")
          .text(vegetable, 50, yPosition)
          .text(qty.toString(), 200, yPosition)
          .text(`₹${price.toFixed(2)}`, 280, yPosition)
          .text(`₹${itemTotal.toFixed(2)}`, 350, yPosition);

        yPosition += 20;
      });

      yPosition += 10;
      doc.moveTo(200, yPosition).lineTo(450, yPosition).stroke();

      // Totals
      yPosition += 20;
      doc.font("Helvetica-Bold")
        .text("Subtotal:", 280, yPosition)
        .text(`₹${subtotal.toFixed(2)}`, 350, yPosition);

      if (order.selectedOffer && order.selectedOffer.price) {
        yPosition += 20;
        const discount = order.selectedOffer.price;
        doc.text("Discount:", 280, yPosition)
          .text(`-₹${discount.toFixed(2)}`, 350, yPosition);
      }

      yPosition += 20;
      const totalAmount = subtotal - (order.selectedOffer?.price || 0);
      doc.text("Total Amount:", 280, yPosition)
        .text(`₹${totalAmount.toFixed(2)}`, 350, yPosition);

      // Payment Info
      yPosition += 40;
      doc.text("Payment Type: COD / Online Payment", 50, yPosition)
        .text("For support: info.vegbazar@gmail.com", 50, yPosition + 15);

      // Footer
      yPosition += 60;
      doc.fontSize(10)
        .text("Thank you for your order!", 50, yPosition, { align: "center" });

      doc.end();

      stream.on("finish", () => resolve(filePath));
      stream.on("error", (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
};


// Send Email with Invoice
export const sendInvoiceEmail = async (order, invoicePath) => {
  try {
    const transporter = createEmailTransporter();

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: order.customerInfo.email,
      subject: `Invoice #${order.orderId} - Fresh Vegetables Store`,
      html: `
        <div style="font-family: 'Trirong', 'Amiko', 'Khula', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #0e540b;">
  
  <h2 style="color: #0e540b; text-align: center;">Thank you for your order!</h2>
  
  <p>Dear ${order.customerInfo.name},</p>
  
  <p>Thank you for choosing <strong>VegBazar</strong>. Your order has been confirmed and is being processed.</p>
  
  <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #0e540b;">Order Details:</h3>
    <p><strong>Order ID:</strong> ${order.orderId}</p>
    <p><strong>Order Date:</strong> ${new Date(order.orderDate).toLocaleDateString()}</p>
    <p><strong>Total Amount:</strong> ₹${order.totalAmount.toFixed(2)}</p>
    <p><strong>Payment Type:</strong> COD / Online Payment</p>
  </div>
  
  <h3 style="color: #0e540b;">Items Ordered:</h3>
  <ul>
    ${order.selectedVegetables
      .map(
        (veg) =>
          `<li>${veg.name} - Quantity: ${veg.quantity} - ₹${(veg.quantity * veg.price).toFixed(2)}</li>`
      )
      .join("")}
  </ul>
  
  ${
    order.selectedOffer && Object.keys(order.selectedOffer).length > 0
      ? `<p style="color: #0e540b;"><strong>Special Offer Applied:</strong> ${order.selectedOffer.title} - ₹${order.selectedOffer.price}</p>`
      : ""
  }
  
  <p>Please find the detailed invoice attached to this email.</p>
  
  <p>If you have any questions about your order, please don't hesitate to contact us.</p>
  
  <p>Best regards,<br><strong>VegBazar Team</strong></p>
  
  <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
  
  <p style="font-size: 12px; color: #666;">
    VegBazar<br>
   Gujarat<br>
    Phone: 9265318453 | Email: info.vegbazar@gmail.com
  </p>
</div>
      `,
      attachments: [
        {
          filename: `invoice-${order.orderId}.pdf`,
          path: invoicePath,
        },
      ],
    };

    const result = await transporter.sendMail(mailOptions);

    // Clean up temporary file
    if (fs.existsSync(invoicePath)) {
      fs.unlinkSync(invoicePath);
    }

    return result;
  } catch (error) {
    throw new Error(`Email sending failed: ${error.message}`);
  }
};

// Main function to generate and send invoice
export const processOrderInvoice = async (orderId) => {
  try {
    // Import Order model (adjust path as needed)
    const Order = (await import("../Model/order.js")).default;

    // Find the order
    const order = await Order.findOne({ _id: orderId });
    if (!order) {
      throw new Error("Order not found");
    }

    console.log(`Processing invoice for order: ${orderId}`);

    // Generate PDF invoice
    const invoicePath = await generateInvoicePDF(order);
    console.log(`Invoice PDF generated: ${invoicePath}`);

    // Send email with invoice
    const emailResult = await sendInvoiceEmail(order, invoicePath);
    console.log(
      `Invoice email sent successfully to: ${order.customerInfo.email}`
    );

    return {
      success: true,
      message: "Invoice generated and sent successfully",
      orderId: orderId,
      emailSent: true,
    };
  } catch (error) {
    console.error("Error processing invoice:", error);
    return {
      success: false,
      message: error.message,
      orderId: orderId,
      emailSent: false,
    };
  }
};

// API endpoint example (Express.js)
export const invoiceController = async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await processOrderInvoice(orderId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
