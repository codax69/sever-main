import * as invoiceController from './src/controller/invoice.js';

console.log('📧 Invoice Controller Analysis:');
const functions = Object.keys(invoiceController);
console.log('  Available functions:', functions.length);
functions.forEach((func, index) => {
  console.log(`    ${index + 1}. ${func}`);
});

console.log('\n📧 Email Configuration Check:');
console.log('  EMAIL_USER:', process.env.EMAIL_USER ? '✅ Set' : '❌ Missing');
console.log('  EMAIL_PASS:', process.env.EMAIL_PASS ? '✅ Set' : '❌ Missing');
console.log('  MAILER_MAIL:', process.env.MAILER_MAIL ? '✅ Set' : '❌ Missing');
console.log('  MAILER_PASSWORD:', process.env.MAILER_PASSWORD ? '✅ Set' : '❌ Missing');

console.log('\n✅ Invoice system analysis complete!');