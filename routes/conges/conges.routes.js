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
        c.date_debut, 
        c.date_fin, 
        c.nb_jours, 
        c.statut,
        tc.libelle as type_conge, -- Ajout pour plus de clarté
        c.created_at
      FROM 
        conge c
      JOIN 
        employe e ON c.employe_id = e.id
      LEFT JOIN 
        type_conge tc ON c.type_conge_id = tc.id
      WHERE 
        c.statut NOT IN ('approuve', 'refuse', 'annule')
      ORDER BY 
        c.created_at DESC;
    `;

    const result = await db.query(sql); // Pas de tableau de paramètres ici
    res.json(result.rows);
  } catch (error) {
    console.error(error); // Toujours utile pour le debug côté serveur
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;