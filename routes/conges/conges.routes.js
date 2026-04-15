const express = require('express');
const router = express.Router();
const db = require('../../config/db.config'); // Ton fichier modifié


router.post('/', async (req, res) => {
  console.log('Requête reçue pour créer un congé:', req.body);

  const {
    employe_id, type_conge_id, date_debut, date_fin,
    nb_jours, motif, demi_journee_debut, demi_journee_fin, justificatif
  } = req.body;

  try {
    const anneeActuelle = new Date(date_debut).getFullYear();
    await db.query('BEGIN');

    // 1. Vérification type
    const typeCheck = await db.query(
      'SELECT deductible_solde FROM type_conge WHERE id = $1',
      [type_conge_id]
    );
    if (typeCheck.rows.length === 0) throw new Error("Type de congé inexistant");
    const isDeductible = typeCheck.rows[0].deductible_solde;

    // 2. Insertion congé
    const congeResult = await db.query(`
      INSERT INTO conge (
        employe_id, type_conge_id, date_debut, date_fin,
        nb_jours, statut, motif, demi_journee_debut, demi_journee_fin, justificatif_url
      ) VALUES ($1, $2, $3, $4, $5, 'en_attente_manager', $6, $7, $8, $9)
      RETURNING id;
    `, [employe_id, type_conge_id, date_debut, date_fin,
      nb_jours, motif, demi_journee_debut, demi_journee_fin, justificatif]);

    const newCongeId = congeResult.rows[0].id;

    // 3. Mise à jour solde
    if (isDeductible) {
      const soldeRes = await db.query(`
        UPDATE solde_conge 
        SET solde_en_attente = solde_en_attente + $1, updated_at = NOW()
        WHERE employe_id = $2 AND type_conge_id = $3 AND annee = $4;
      `, [nb_jours, employe_id, type_conge_id, anneeActuelle]);

      if (soldeRes.rowCount === 0) {
        throw new Error(`Aucun solde trouvé pour l'année ${anneeActuelle}.`);
      }
    }

    // 4. Historique workflow
    await db.query(`
      INSERT INTO workflow_conge_etape (conge_id, approbateur_id, niveau, action, commentaire)
      VALUES ($1, $2, 0, 'creation', 'Demande soumise via l''application');
    `, [newCongeId, employe_id]);

    await db.query('COMMIT');
    res.status(201).json({ success: true, congeId: newCongeId });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Erreur création congé:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
// GET /api/conges/soldes/:employe_id
router.get('/soldes/:employe_id/:typeId', async (req, res) => {
  try {
    const { employe_id, typeId } = req.params;
    const annee = new Date().getFullYear();

    const sql = `
      SELECT 
        tc.libelle, 
        tc.code,
        sc.solde_initial, 
        sc.solde_acquis, 
        sc.solde_pris, 
        sc.solde_en_attente,
        sc.solde_restant
      FROM solde_conge sc
      JOIN type_conge tc ON sc.type_conge_id = tc.id
      WHERE sc.employe_id = $1 AND sc.annee = $2 AND tc.id = $3;
    `;
    const result = await db.query(sql, [employe_id, annee, typeId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }


});

// GET /api/conges/historique/:employe_id
router.get('/historique/:employe_id', async (req, res) => {
  try {
    const { employe_id } = req.params;
    const sql = `
      SELECT 
        c.id,
        tc.libelle as type,
        c.date_debut,
        c.date_fin,
        c.nb_jours,
        c.statut,
        c.created_at
      FROM conge c
      JOIN type_conge tc ON c.type_conge_id = tc.id
      WHERE c.employe_id = $1
      ORDER BY c.created_at DESC;
    `;
    const result = await db.query(sql, [employe_id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conges/soldes/:employe_id
router.get('/type_conge', async (req, res) => {
  try {
    const sql = `SELECT * FROM type_conge ORDER BY libelle`;
    const result = await db.query(sql);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur type_conge:', error); // ← log complet
    res.status(500).json({ error: error.message });
  }
});

router.get('/conges_en_attente', async (req, res) => {
  try {
    // Note : On retire les paramètres inutilisés dans le SQL pour éviter l'erreur 
    // "bind message has X parameters, but prepared statement requires 0"

    const sql = `
        SELECT 
            c.id,
            e.nom, 
            e.prenom, 
            e.matricule, -- Ajouté pour votre template Angular
            c.date_debut, 
            c.date_fin, 
            c.nb_jours, 
            c.statut,
            c.motif,
            tc.libelle as type_conge,
            tc.code as code_type,
            c.created_at,
            sc.solde_restant, -- On récupère le solde depuis la table solde_conge
            sc.solde_initial -- Solde initial pour affichage dans le détail
        FROM 
            conge c
        JOIN 
            employe e ON c.employe_id = e.id
        LEFT JOIN 
            type_conge tc ON c.type_conge_id = tc.id
        LEFT JOIN 
            solde_conge sc ON (
                sc.employe_id = c.employe_id 
                AND sc.type_conge_id = c.type_conge_id 
                AND sc.annee = EXTRACT(YEAR FROM c.date_debut)
            )
        WHERE 
            c.statut NOT IN ('approuve', 'refuse', 'annule')
        ORDER BY 
            c.created_at DESC;`;

    const result = await db.query(sql); // Pas de tableau de paramètres ici
    res.json(result.rows);
  } catch (error) {
    console.error(error); // Toujours utile pour le debug côté serveur
    res.status(500).json({ error: error.message });
  }
});

router.patch('/valider/:id', async (req, res) => {
  const congeId = req.params.id;
  const { approbateur_id, commentaire } = req.body; // L'ID du manager ou RH qui valide

  try {
    await db.query('BEGIN');

    // 1. Récupérer les infos du congé avant modification
    const congeInfo = await db.query(
      `SELECT employe_id, type_conge_id, nb_jours, date_debut 
       FROM conge WHERE id = $1 FOR UPDATE`,
      [congeId]
    );

    if (congeInfo.rows.length === 0) throw new Error("Congé introuvable");

    const { employe_id, type_conge_id, nb_jours, date_debut } = congeInfo.rows[0];
    const annee = new Date(date_debut).getFullYear();

    // 2. Mettre à jour le statut du congé
    // Note: Passe à 'approuve' (ou 'en_attente_rh' si vous avez 2 niveaux)
    await db.query(
      "UPDATE conge SET statut = 'approuve', updated_at = NOW() WHERE id = $1",
      [congeId]
    );

    // 3. Mettre à jour le solde (Déduire de 'en_attente' et ajouter à 'pris')
    // On vérifie d'abord si le type est déductible
    const typeCheck = await db.query('SELECT deductible_solde FROM type_conge WHERE id = $1', [type_conge_id]);

    if (typeCheck.rows[0].deductible_solde) {
      const updateSolde = await db.query(`
UPDATE solde_conge 
    SET
      solde_initial = solde_restant,
      solde_restant = solde_restant - $1,
      updated_at = NOW()
    WHERE employe_id = $2 AND type_conge_id = $3 AND annee = $4      `,
        [nb_jours, employe_id, type_conge_id, annee]);

      if (updateSolde.rowCount === 0) throw new Error("Erreur lors de la mise à jour du solde");
    }

    // 4. Enregistrer l'étape dans le workflow
    await db.query(`
      INSERT INTO workflow_conge_etape (conge_id, approbateur_id, niveau, action, commentaire)
      VALUES ($1, $2, 1, 'approuve', $3)
    `, [congeId, approbateur_id, commentaire || 'Approuvé par le manager']);

    await db.query('COMMIT');
    res.json({ success: true, message: "Congé validé avec succès" });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Erreur validation congé:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
router.patch('/refuser/:id', async (req, res) => {
  const congeId = req.params.id;
  const { approbateur_id, commentaire_refus } = req.body;

  try {
    await db.query('BEGIN');

    const congeInfo = await db.query(
      `SELECT employe_id, type_conge_id, nb_jours, date_debut FROM conge WHERE id = $1`, [congeId]
    );
    const { employe_id, type_conge_id, nb_jours, date_debut } = congeInfo.rows[0];
    const annee = new Date(date_debut).getFullYear();

    // 1. Statut en 'refuse' et stockage du motif de refus
    await db.query(
      "UPDATE conge SET statut = 'refuse', commentaire_refus = $2, updated_at = NOW() WHERE id = $1",
      [congeId, commentaire_refus]
    );

    // 2. Libérer le solde bloqué en attente
    await db.query(`
      UPDATE solde_conge 
      SET solde_en_attente = solde_en_attente - $1, updated_at = NOW()
      WHERE employe_id = $2 AND type_conge_id = $3 AND annee = $4
    `, [nb_jours, employe_id, type_conge_id, annee]);

    // 3. Workflow
    await db.query(`
      INSERT INTO workflow_conge_etape (conge_id, approbateur_id, niveau, action, commentaire)
      VALUES ($1, $2, 1, 'refuse', $3)
    `, [congeId, approbateur_id, commentaire_refus]);

    await db.query('COMMIT');
    res.json({ success: true, message: "Congé refusé" });
  } catch (error) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});
*/

router.get('/employe_solde', async (req, res) => {
  try {
    const sql =
      `
      SELECT
      e.id              AS employe_id,
      e.matricule,
      e.nom,
      e.prenom,
      e.email_pro,
      e.statut          AS statut_employe,
      e.photo_url,
      json_agg(
        json_build_object(
          'type_conge_id',    tc.id,
          'libelle',          tc.libelle,
          'solde_initial',    sc.solde_initial,
          'solde_acquis',     sc.solde_acquis,
          'solde_pris',       sc.solde_pris,
          'solde_en_attente', sc.solde_en_attente,
          'solde_restant',    sc.solde_restant
        ) ORDER BY tc.libelle
      ) AS soldes
    FROM employe e
    LEFT JOIN solde_conge sc
           ON sc.employe_id = e.id
    LEFT JOIN type_conge tc
           ON tc.id = sc.type_conge_id
    WHERE e.statut = 'actif'
    GROUP BY e.id, e.matricule, e.nom, e.prenom, e.email_pro, e.statut
    ORDER BY e.nom, e.prenom
    `;
    const result = await db.query(sql);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur type_conge:', error); // ← log complet
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;