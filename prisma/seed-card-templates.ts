// Idempotent seed for the 12 visual card templates shipped at launch.
// Mirrors the catalogue shown in the back-office Cards Gallery.
// Usage: npm run db:seed:card-templates
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Tpl = {
  themeKey: string;
  name: string;
  emoji: string;
  color: string;
  ink?: string;
  category: string;
  isLive?: boolean;
  sortOrder: number;
};

const TEMPLATES: Tpl[] = [
  { themeKey: 'anniversaire',    name: 'Anniversaire',     emoji: '🎂', color: '#F4486F', category: 'Famille · Fêtes',     sortOrder: 10 },
  { themeKey: 'saint-valentin',  name: 'Saint-Valentin',   emoji: '💖', color: '#ED4673', category: 'Romantique',           sortOrder: 20 },
  { themeKey: 'mariage',         name: 'Mariage',          emoji: '💍', color: '#FFFFFF', ink: '#2A0F1A', category: 'Famille · Fêtes', sortOrder: 30 },
  { themeKey: 'condoleances',    name: 'Condoléances',     emoji: '🕊️', color: '#7B278C', category: 'Solidarité',            sortOrder: 40 },
  { themeKey: 'bravo',           name: 'Bravo',            emoji: '🏆', color: '#F9A01C', ink: '#2A0F1A', category: 'Encouragement',  sortOrder: 50 },
  { themeKey: 'noel',            name: 'Noël',             emoji: '🎄', color: '#5DBFA0', category: 'Famille · Fêtes',     isLive: false, sortOrder: 60 },
  { themeKey: 'tabaski',         name: 'Tabaski',          emoji: '🌙', color: '#41087B', category: 'Famille · Fêtes',     sortOrder: 70 },
  { themeKey: 'naissance',       name: 'Naissance',        emoji: '👶', color: '#6FB5D4', category: 'Famille · Fêtes',     sortOrder: 80 },
  { themeKey: 'bon-voyage',      name: 'Bon voyage',       emoji: '✈️', color: '#2A0454', category: 'Encouragement',        sortOrder: 90 },
  { themeKey: 'goshop',          name: 'GoShop',           emoji: '🛍️', color: '#FFFFFF', ink: '#2A0F1A', category: 'Cadeaux',  sortOrder: 100 },
  { themeKey: 'bonjour',         name: 'Bonjour',          emoji: '👋', color: '#F4486F', category: 'Quotidien',            sortOrder: 110 },
  { themeKey: 'diplome',         name: 'Diplôme',          emoji: '🎓', color: '#FFFFFF', ink: '#2A0F1A', category: 'Encouragement', isLive: false, sortOrder: 120 },
];

async function main() {
  console.log('🎨 Seeding card templates (idempotent)...');
  for (const t of TEMPLATES) {
    const result = await prisma.cardTemplate.upsert({
      where: { themeKey: t.themeKey },
      update: {
        name: t.name,
        emoji: t.emoji,
        color: t.color,
        ink: t.ink ?? '#FDF7F6',
        category: t.category,
        sortOrder: t.sortOrder,
      },
      create: {
        themeKey: t.themeKey,
        name: t.name,
        emoji: t.emoji,
        color: t.color,
        ink: t.ink ?? '#FDF7F6',
        category: t.category,
        isLive: t.isLive ?? true,
        sortOrder: t.sortOrder,
      },
    });
    console.log(`  · ${result.isLive ? 'LIVE ' : 'DRAFT'}\t${result.themeKey}`);
  }
  console.log('✅ Done.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
