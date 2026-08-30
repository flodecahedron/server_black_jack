# Serveur Blackjack

Le serveur WebSocket est l'autorité des règles de partie et des jetons de la table.

## Règles monétaires

- `set_bet` immobilise immédiatement la mise du joueur. Elle est rendue sur égalité et réglée à la fin de la manche.
- Double et split immobilisent une mise supplémentaire seulement si le joueur et la banque peuvent la couvrir.
- Un blackjack joueur paie exactement `3/2` de gain net (`2,5 ×` la mise rendue). Les demi-jetons sont conservés pour les mises impaires.
- Un joueur ou croupier dont le solde tombe à zéro après le règlement reçoit automatiquement 100 T afin de pouvoir continuer à jouer.

## Croupier-joueur

Un joueur choisit une banque avec `become_dealer` et peut l'ajuster avec `set_dealer_liability` entre les manches. Avec `n` adversaires, chaque mise est plafonnée à :

`floor(2 × banque / (3 × n))`

Ainsi la banque peut payer le pire cas : tous les adversaires font blackjack en même temps. Le serveur refait aussi ce contrôle au lancement de manche, puis à chaque double ou split.

## Vérification

Exécuter `npm test` dans ce dossier pour vérifier les règlements et les réserves de banque.
