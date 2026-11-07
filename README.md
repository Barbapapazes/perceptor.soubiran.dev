# Perceptor

Worker Cloudflare minimal : chaque requête reçoit `200`, `Hello World!` et
`Content-Type: text/plain; charset=utf-8`.

## Prérequis

- Node.js **24.22.0** (version fixée dans `.node-version` et compatible avec `cf`).
- pnpm **10.34.5** (déclaré dans `packageManager`).

Avec nvm :

```sh
nvm install 24.22.0
nvm use 24.22.0
pnpm install --frozen-lockfile
```

Aucun compte Cloudflare n'est nécessaire pour développer, tester ou construire.

## Commandes

```sh
pnpm dev             # cf dev, http://localhost:5173
pnpm check           # Formatage, lint, génération des types et TypeScript
pnpm format          # Formater avec Vite+
pnpm test            # Tests dans workerd via @cloudflare/vitest-plugin
pnpm test:watch      # Tests en mode watch
pnpm build           # cf build, qui utilise Vite+
pnpm deploy:dry-run  # Construire et valider sans déployer ni appeler l'API
```

Le projet utilise Vite+ et le nouveau CLI `cf` avec le plugin Cloudflare Vite v2.
**`cf` et le plugin v2 sont en bêta** ; leurs versions sont fixées dans
`package.json` et les résolutions sont conservées dans `pnpm-lock.yaml`.
Les alias et overrides Vite/Vitest dans `pnpm-workspace.yaml` proviennent du
migrateur officiel Vite+ et permettent aux plugins d'utiliser le même outillage.

## Configuration

- `cloudflare.config.ts` : source de vérité du Worker `perceptor`, date de
  compatibilité et observabilité. Aucun binding ni domaine configuré.
- `vite.config.ts` : intégration Cloudflare Vite.
- `vitest.config.ts` : tests Vite+ utilisant le plugin Cloudflare et la même
  configuration Worker ; les bindings distants sont désactivés pour les tests.
- `.cloudflare/` : types et builds générés, ignorés par Git. Le build Cloudflare
  produit les source maps du Worker automatiquement.

Ne pas ajouter de configuration Wrangler parallèle à cette chaîne `cf`.
Ne jamais versionner de secrets ; les fichiers `.env*` et `.dev.vars*` locaux
sont ignorés, à l'exception des éventuels exemples.

## MCP Cloudflare pour pi

Le seul serveur déclaré dans `.pi/mcp.json` est `cloudflare`, connecté en HTTP à
`https://mcp.cloudflare.com/mcp`. La configuration est locale au projet, mais le
serveur est hébergé par Cloudflare. Aucun token n'est enregistré dans le dépôt.

1. Ouvrir pi dans ce dossier et accorder la confiance au projet (`/trust`).
2. Recharger avec `/reload` si la session était déjà ouverte.
3. Si une authentification est demandée, utiliser `/mcp login cloudflare` dans pi
   ou `pi mcp login cloudflare` depuis le terminal.
4. Vérifier avec `/mcp` ou `pi mcp list`.

N'autoriser que les permissions Cloudflare nécessaires. Les identifiants OAuth
sont gérés par pi dans son stockage utilisateur, hors du projet.

## Déploiement volontaire

Aucun déploiement n'est effectué lors de l'installation ou des vérifications.
Quand le compte et le domaine auront été choisis :

```sh
pnpm exec cf auth login
pnpm deploy
```

L'authentification de `cf` est distincte de celle du MCP pi.

## Documentation

- [Premier Worker avec cf](https://developers.cloudflare.com/cf/get-started/first-worker/)
- [Vite+ sur Workers](https://developers.cloudflare.com/workers/vite-plugin/vite-plus/)
- [Tests Cloudflare Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Migration Vite+](https://viteplus.dev/guide/migrate)
- [MCP Cloudflare](https://github.com/cloudflare/mcp)
