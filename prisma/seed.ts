// Seed — crée 3 users de demo + 2 cards + 1 cagnotte
// Usage: npm run db:seed
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Donia demo data...');

  const password = await bcrypt.hash('demo1234', 10);

  // Wipe in safe order (dev only — DON'T run in prod)
  await prisma.cardReaction.deleteMany();
  await prisma.cagnotteContribution.deleteMany();
  await prisma.cagnotte.deleteMany();
  await prisma.kycSubmission.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.card.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otp.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();

  const awa = await prisma.user.create({
    data: {
      name: 'Awa Diallo',
      phone: '+22990123456',
      whatsapp: '+22990123456',
      email: 'awa@donia.app',
      passwordHash: password,
      sex: 'F',
      country: 'BJ',
      city: 'Cotonou',
      referralCode: 'AWA-2026',
      phoneVerified: true,
      kycStatus: 'APPROVED',
      wallet: { create: { balancePrincipal: new Prisma.Decimal(95800), balanceReferral: new Prisma.Decimal(30000) } },
    },
  });

  const kofi = await prisma.user.create({
    data: {
      name: 'Kofi Mensah',
      phone: '+22994502187',
      whatsapp: '+22994502187',
      passwordHash: password,
      sex: 'M',
      country: 'BJ',
      referralCode: 'KOFI-2026',
      referredBy: 'AWA-2026',
      phoneVerified: true,
      wallet: { create: { balancePrincipal: new Prisma.Decimal(12500) } },
    },
  });

  const marie = await prisma.user.create({
    data: {
      name: 'Marie Dossou',
      phone: '+22995110342',
      whatsapp: '+22995110342',
      email: 'marie@donia.app',
      passwordHash: password,
      sex: 'F',
      country: 'BJ',
      referralCode: 'MARIE-2026',
      phoneVerified: true,
      wallet: { create: { balancePrincipal: new Prisma.Decimal(48200) } },
    },
  });

  // Referral
  await prisma.referral.create({ data: { parrainId: awa.id, filleulId: kofi.id } });

  // 2 demo cards
  await prisma.card.create({
    data: {
      redeemCode: 'DON-2026-A7K91',
      senderId: marie.id,
      recipientId: awa.id,
      recipientPhone: awa.phone,
      recipientName: 'Awa',
      occasion: 'anniversaire',
      themeKey: 'anniversaire',
      amount: new Prisma.Decimal(5000),
      message: "Bonne fête d'anniversaire ma chérie 🌻",
      palette: 'pink',
      deliveryChannel: 'WHATSAPP',
      status: 'SENT',
      sentAt: new Date(),
    },
  });
  await prisma.card.create({
    data: {
      redeemCode: 'DON-2026-B8L92',
      senderId: awa.id,
      recipientPhone: kofi.phone,
      recipientName: 'Kofi',
      occasion: 'bonjour',
      themeKey: 'bonjour',
      amount: new Prisma.Decimal(10000),
      message: 'Profite bien de ta journée mon frère',
      palette: 'coral',
      deliveryChannel: 'WHATSAPP',
      status: 'SENT',
      sentAt: new Date(),
    },
  });

  // 1 cagnotte
  await prisma.cagnotte.create({
    data: {
      ownerId: awa.id,
      title: 'Anniversaire surprise de Maman',
      goalAmount: new Prisma.Decimal(100000),
      totalRaised: new Prisma.Decimal(55000),
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  });

  console.log('✅ Seed done.');
  console.log('   Test login: phone=+22990123456 password=demo1234 (Awa)');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
