import Customer from "../Model/customer.js"; 
import nodemailer from "nodemailer";

export const exportCustomers = async (req, res) => {
  try {
    // Get all customers directly from Customer model
    const customers = await Customer.find({}).lean();
    
    // console.log(`👥 Total customers found: ${customers.length}`);
    
    if (!customers || customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No customers found in database'
      });
    }

    // Create CSV with Name, Email, Mobile
    let csv = 'Name,Email,Mobile\n';
    
    customers.forEach(customer => {
      const name = (customer.name || '').replace(/"/g, '""').trim();
      const email = (customer.email || '').replace(/"/g, '""').trim();
      const mobile = (customer.mobile || '').replace(/"/g, '""').trim();
      
      csv += `"${name}","${email}","${mobile}"\n`;
    });

    // console.log(`📄 CSV created with ${customers.length} customers`);

    // Send email with CSV attachment
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `"Customer Export System" <${process.env.EMAIL_USER}>`,
      cc: process.env.ADMIN_EMAIL,
      subject: `Customer Export - ${customers.length} Customers`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2 style="color: #4472C4;">📊 Customer Data Export</h2>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 10px 0;"><strong>👥 Total Customers:</strong> ${customers.length}</p>
            <p style="margin: 10px 0;"><strong>📅 Export Date:</strong> ${new Date().toLocaleString()}</p>
          </div>
          <p>Please find attached the CSV file with all customer details.</p>
          <div style="background-color: #e7f3ff; padding: 15px; border-left: 4px solid #4472C4; margin: 20px 0;">
            <p style="margin: 0;"><strong>📎 File:</strong> customers.csv</p>
            <p style="margin: 5px 0 0 0;"><strong>📋 Columns:</strong> Name, Email, Mobile</p>
          </div>
          <hr style="border: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">This is an automated export from Customer Export System.</p>
        </div>
      `,
      attachments: [{
        filename: 'customers.csv',
        content: csv,
        contentType: 'text/csv; charset=utf-8'
      }]
    });

    // console.log(`✉️ Email sent successfully to ${process.env.ADMIN_EMAIL}`);

    return res.status(200).json({
      success: true,
      message: `Successfully exported ${customers.length} customers and sent to admin email`,
      totalCustomers: customers.length
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error exporting customers',
      error: error.message
    });
  }
};