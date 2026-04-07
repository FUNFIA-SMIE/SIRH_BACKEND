const express = require('express');
const router = express.Router();
const db = require('../../config/db.config'); // Import de ton pool de connexion pg

// 1. LISTER TOUS LES EMPLOYÉS (avec jointures Poste et Département)
// GET /employes
router.get('/', async (req, res) => {
    try {
        const sql = `
            SELECT *,e.id AS employe_id, e.nom AS nom_employe, e.prenom AS prenom_employe
            FROM employe e
            LEFT JOIN departement d ON e.departement_id = d.id
            LEFT JOIN poste p ON e.poste_id = p.id
            ORDER BY e.created_at DESC;
        `;
        const result = await db.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Erreur lors de la récupération : " + err });
    }
});

// 2. RÉCUPÉRER UN EMPLOYÉ PAR SON ID (UUID)
// GET /employes/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('SELECT * FROM employe WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Employé non trouvé" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: "ID invalide ou erreur serveur" });
    }
});

// 3. CRÉER UN NOUVEL EMPLOYÉ
// POST /employes
router.post('/', async (req, res) => {
    const { 
        organisation_id, matricule, civilite, nom, prenom, 
        nom_usage, genre, date_naissance, lieu_naissance, 
        nationalite, cin, email_pro, email_perso, telephone_pro,
        adresse, ville, pays, departement_id, poste_id, date_entree 
    } = req.body;

    const sql = `
        INSERT INTO employe (
            organisation_id, matricule, civilite, nom, prenom, 
            nom_usage, genre, date_naissance, lieu_naissance, 
            nationalite, cin, email_pro, email_perso, telephone_pro,
            adresse, ville, pays, departement_id, poste_id, date_entree
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        ) RETURNING *;
    `;

    const values = [
        organisation_id, matricule, civilite, nom, prenom, 
        nom_usage, genre, date_naissance, lieu_naissance, 
        nationalite, cin, email_pro, email_perso, telephone_pro,
        adresse, ville, pays, departement_id, poste_id, date_entree
    ];

    try {
        const result = await db.query(sql, values);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: "Conflit : Le matricule, l'email ou le CIN existe déjà." });
        }
        res.status(500).json({ error: err.message });
    }
});

// 4. METTRE À JOUR UN EMPLOYÉ
// PATCH /employes/:id
router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const fields = req.body; // Objet contenant les colonnes à modifier
    
    // Construction dynamique de la requête SQL
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Aucun champ à modifier" });

    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const values = Object.values(fields);
    values.push(id); // L'ID pour la clause WHERE

    try {
        const sql = `UPDATE employe SET ${setClause}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
        const result = await db.query(sql, values);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. SUPPRIMER UN EMPLOYÉ
// DELETE /employes/:id
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('DELETE FROM employe WHERE id = $1 RETURNING *', [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Employé introuvable" });
        }
        res.json({ message: "Employé supprimé avec succès" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;