var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

var employeRouter = require('./routes/employes/employe.routes');
var departementRouter = require('./routes/employes/departement.routes');
var posteRouter = require('./routes/employes/poste.routes');


var app = express();
app.use(cors());
app.use(cors({
  origin: '*' // Remplace par l'URL exacte de ton frontend
}));

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/employes', employeRouter); // Assure-toi d'importer employeRouter en haut du fichier
app.use('/departements', departementRouter); // Assure-toi d'importer departementRouter en haut du fichier
app.use('/postes', posteRouter); // Assure-toi d'importer posteRouter en haut du fichier

module.exports = app;
