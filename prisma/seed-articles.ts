// Idempotent seed for the 3 initial blog posts shown on doniia.com/#blog.
// Safe to run any time — uses upsert on slug.
// Usage in dev:        npm run db:seed:articles
// On Railway (one-off): railway run npm run db:seed:articles
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ARTICLES = [
  {
    slug: '5-facons-celebrer-anniversaire-distance',
    title: '5 façons de célébrer un anniversaire à distance',
    category: 'Conseil',
    excerpt:
      "Quand la famille est éparpillée sur 3 continents, la présence prend une autre forme.",
    content: [
      "Quand la famille est éparpillée sur 3 continents, la présence prend une autre forme.",
      '',
      'Voici 5 idées qui ont marqué nos premiers utilisateurs pour rappeler à un proche qu’on pense à lui malgré la distance.',
      '',
      '1) La carte vidéo collective — chaque membre de la famille enregistre 30 secondes, on monte le tout en une vidéo surprise envoyée le jour J.',
      '',
      '2) Le rituel WhatsApp — un message vocal à minuit, un appel groupé à midi, une carte cadeau Donia au goûter. Trois rendez-vous, trois preuves de présence.',
      '',
      "3) La carte Donia avec message vocal — l’avantage : le destinataire écoute ta voix, garde la carte en souvenir, et convertit le montant en Mobile Money quand il veut.",
      '',
      '4) L’apéro Zoom à 3 fuseaux — Cotonou, Paris, Montréal. On boit en même temps, chacun à son heure. Bonus : on envoie une mini cagnotte pour que la personne fêtée s’offre un dîner.',
      '',
      '5) L’album photo surprise — chaque proche envoie 3 photos préférées de la personne, on imprime un livret. Effet garanti.',
      '',
      "La distance n’est pas une fatalité. Ce sont les rituels qu’on invente qui font la présence.",
    ].join('\n'),
    emoji: '🎂',
    color: '#F4486F',
    readMinutes: 4,
    author: 'Équipe Donia',
    publishedAt: new Date('2026-05-24T09:00:00Z'),
  },
  {
    slug: 'awa-cotonou-4-cartes-par-mois',
    title: 'Awa, Cotonou : « J’envoie 4 cartes par mois »',
    category: 'Témoignage',
    excerpt:
      "Portrait d’une utilisatrice qui a transformé sa façon d’être en lien avec ses proches.",
    content: [
      'Awa a 32 ans, vit à Cotonou et travaille dans la communication. Depuis qu’elle a découvert Donia il y a 6 mois, elle a complètement changé sa façon d’être en lien avec ses proches restés à Lagos, Abidjan, Paris.',
      '',
      '« Avant, je ratais les anniversaires. Je m’en rendais compte deux jours après, je culpabilisais, et au final je n’envoyais rien parce que c’était déjà trop tard. »',
      '',
      'Aujourd’hui, Awa envoie en moyenne 4 cartes par mois — un anniversaire, une fête, parfois juste un “je pense à toi” un mardi soir. Le geste prend 30 secondes : choix de la carte, montant, message, envoi WhatsApp.',
      '',
      '« Ce qui a changé, ce n’est pas l’argent. C’est que je suis présente. Mes cousines à Lagos savent que je pense à elles. Et quand elles convertissent la carte en Mobile Money, c’est un petit câlin de loin. »',
      '',
      'Le programme de parrainage est devenu un bonus inattendu : ses 12 filleules lui rapportent en moyenne 8 000 FCFA par mois en commissions à vie.',
      '',
      '« C’est devenu mon rituel du dimanche soir. Je regarde mon calendrier de la semaine, je vois qui fête quoi, et j’envoie. Simple. »',
    ].join('\n'),
    emoji: '💝',
    color: '#41087B',
    readMinutes: 4,
    author: 'Équipe Donia',
    publishedAt: new Date('2026-05-20T09:00:00Z'),
  },
  {
    slug: 'cartes-tabaski-2026-3-designs-exclusifs',
    title: 'Cartes Tabaski 2026 : 3 designs exclusifs',
    category: 'Produit',
    excerpt:
      "Notre studio a travaillé avec un illustrateur sénégalais. Découvre les coulisses.",
    content: [
      'Cette année pour la Tabaski, nous avons voulu sortir des codes habituels. Trop souvent, les visuels qu’on voit reproduisent les mêmes images de mouton et de croissant de lune. On voulait quelque chose qui parle aux jeunes diasporas autant qu’aux familles du continent.',
      '',
      'Nous avons collaboré avec Mamadou Sow, illustrateur basé à Dakar, formé à l’École des Beaux-Arts de Dakar et passionné de ré-interprétations contemporaines des motifs ouest-africains.',
      '',
      'Trois designs sont nés de cette collaboration :',
      '',
      '— « Le Mouton d’Or » — une réinterprétation art-déco du mouton sacrifié, sur fond mango profond.',
      '— « Sous la Lune » — calligraphie arabe stylisée, ciel étoilé, palette indigo et coral.',
      '— « La Famille Réunie » — silhouettes contemporaines autour d’une table, dans des tons chauds.',
      '',
      'Les 3 cartes sont disponibles dans l’app dès le 1er juin, et pendant tout le mois de Tabaski. Une partie des frais collectés sur ces cartes sera reversée à une association de soutien aux artisans illustrateurs ouest-africains.',
    ].join('\n'),
    emoji: '🌙',
    color: '#F9A01C',
    readMinutes: 4,
    author: 'Équipe Donia',
    publishedAt: new Date('2026-05-15T09:00:00Z'),
  },
];

async function main() {
  console.log('🌱 Seeding blog articles (idempotent)...');
  for (const a of ARTICLES) {
    const result = await prisma.article.upsert({
      where: { slug: a.slug },
      update: {
        // Only refresh editable fields if the article already exists.
        // Status is preserved so re-seeding does not republish what an admin archived.
        title: a.title,
        category: a.category,
        excerpt: a.excerpt,
        content: a.content,
        emoji: a.emoji,
        color: a.color,
        readMinutes: a.readMinutes,
        author: a.author,
      },
      create: {
        slug: a.slug,
        title: a.title,
        category: a.category,
        excerpt: a.excerpt,
        content: a.content,
        emoji: a.emoji,
        color: a.color,
        readMinutes: a.readMinutes,
        author: a.author,
        status: 'PUBLISHED',
        publishedAt: a.publishedAt,
      },
    });
    console.log(`  · ${result.status}\t${result.slug}`);
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
