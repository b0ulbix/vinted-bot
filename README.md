# 🔔 Vinted Bot — alertes en temps réel + tableau de bord

Bot qui surveille Vinted en continu, envoie une alerte **Discord** ou **Telegram** dès qu'une nouvelle annonce correspond à une recherche, et **repère automatiquement les bonnes affaires** en estimant la cote de chaque article.

> 🇬🇧 *Real-time Vinted listing monitor with a web dashboard: Discord/Telegram alerts with photos, automatic deal detection (price estimation), password-protected dashboard, deployed on a Linux server behind a Cloudflare Tunnel.*

## Fonctionnalités

- **Recherches illimitées** : mots-clés, prix maximum, groupes pour les ranger.
- **Alertes avec photos** sur Discord (webhook, un salon par recherche possible) et Telegram (bot), avec un bouton « Acheter ».
- **Détection des bonnes affaires** :
  - cartes Pokémon : comparaison avec les prix du marché (Cardmarket, via l'API gratuite pokemontcg.io) ;
  - autres articles : comparaison avec les annonces similaires. Le bot prend le prix sous lequel se trouvent 35 % des annonces, plus réaliste que la moyenne car beaucoup d'annonces trop chères ne se vendent jamais.
- **Tableau de bord web** protégé par mot de passe : ajout et modification des recherches, historique des annonces, réglages des notifications.
- **Robuste** : file d'attente pour respecter les limites de Discord, nouvelles tentatives automatiques, une seule alerte par annonce.

## Technique

| Partie | Outils |
|---|---|
| Serveur | Node.js 22+, Express |
| Base de données | SQLite (module `node:sqlite` intégré à Node) |
| Images | sharp (redimensionnement des photos) |
| Interface | HTML, CSS, JavaScript sans framework |
| Mise en ligne | Serveur Ubuntu, services systemd, Cloudflare Tunnel (HTTPS sans ouvrir de port) |
| Sécurité | Session signée HMAC, comparaison des mots de passe en temps constant, cookie `httpOnly` |

```
src/
  server.js    API + tableau de bord + connexion
  scanner.js   boucle de surveillance des recherches
  vinted.js    récupération des annonces
  pricing.js   estimation de la cote / bonnes affaires
  notify.js    envoi Discord et Telegram
  db.js        base SQLite et migrations
public/        interface web
deploy/        installation sur serveur Linux
scripts/       lancement sous Windows (démarrage auto)
```

## Lancer le projet

```bash
npm install
cp .env.example .env   # puis choisir un mot de passe dans DASHBOARD_PASSWORD
npm start
```

Le tableau de bord s'ouvre sur http://localhost:3000.

---
Projet personnel réalisé par **Ethan Vandenbon** · [LinkedIn](https://www.linkedin.com/in/ethan-vandenbon/)
