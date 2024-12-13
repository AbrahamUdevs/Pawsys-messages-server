const express = require('express');
const sequelize = require('./db');
const app = express();
const axios = require('axios');
const dotenv = require('dotenv');
const jwt = require("jsonwebtoken");
const WebSocket = require('ws');
const { Json } = require('sequelize/lib/utils');
dotenv.config();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

var conn = new WebSocket(`ws://${process.env.PAWSY_WEBSOCKET_SERVER}`);
conn.onopen = function(e) {
  console.log('Conexión exitosa con el websocket.');
}

sequelize.authenticate()
  .then(() => {
    console.log('Conexión exitosa a la base de datos.');
  })
  .catch((err) => {
    console.error('No se pudo conectar a la base de datos:', err);
  });

const { WEBHOOK_VERIFY_TOKEN, PORT } = process.env;

app.get('/facebook-conversations', async function(req, res) {
    try{
      const page = await get_page_access(req.query.user, req.query.page, req.query.access_token);
      
      console.log(page);
  
      const urlConversations = `https://graph.facebook.com/v21.0/${page.id}/conversations?platform=${req.query.platform}&access_token=${page.access_token}`;
  
      const conversations = await axios.get(urlConversations);

      res.send({ "status" : true, "data": conversations.data });
    }
    catch(error){
      console.log(error);
      res.send({ "status" : false });
    }
});

app.get('/facebook-conversations-messages', async function(req, res) {
    try{
        
      const page = await get_page_access(req.query.user, req.query.page, req.query.access_token);

      const urlAPI = `https://graph.facebook.com/v21.0/${req.query.conversation}?fields=messages&access_token=${page.access_token}`;
    
      const msgResp = await axios.get(urlAPI);

      const messages = msgResp.data.messages.data.map(msg => getMessagesTranslation(msg, page.access_token));

      try {
        const results = await Promise.all(messages);

        let resReturn = [];
        results.forEach(item => {
            let owner = item.from.id == req.query.page ? "E" : "R";
            resReturn.push({ "owner": item.from.id, "type": owner, "message": item.message, "created_at":item.created_time });
        });
        
        resReturn.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        
        res.send({ "status" : true, "data": resReturn });
        
      } catch (error) {
        res.send({ "status" : false });
      }
    }
    catch(error){
      res.send({ "status" : false });
    }
});

app.get('/facebook-conversations-messages-response', async function(req, res) {
    try{
        
      const page = await get_page_access(req.query.user, req.query.page, req.query.access_token);

      const urlAPI = `https://graph.facebook.com/v21.0/${req.query.page}/messages?recipient={'id':'${req.query.chat}'}&messaging_type=RESPONSE&message={'text':'${req.query.message}'}&access_token=${page.access_token}&platform=${req.query.platform}`;
    
      const msgResp = await axios.post(urlAPI);

      res.send({ "status" : true, "data": msgResp.data });
    }
    catch(error){
      res.send({ "status" : false });
    }
});

app.get('/user-information', async function (req, res) {
  try{
    const urlAPI = `https://graph.facebook.com/${req.query.user}?access_token=${req.query.access_token}`;
    
    const msgResp = await axios.get(urlAPI);

    res.send({ "status" : true, "data": msgResp.data });
  }
  catch (error){

  }
});

app.post("/webhook/:channelId", async (req, res) => {
  
  try{
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  if (message?.type === "text") {
      const dateUtc = new Date(message.timestamp * 1000);
      
      const options = {
        timeZone: 'America/Guatemala',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      };
      
      const dateInGmtMinus6 = new Intl.DateTimeFormat('es-CR', options).format(dateUtc);
    
      conn.send(JSON.stringify({ "type": "message", "message": message.text.body, "channelId": req.params.channelId}));
      /*const token = await axios.get(process.env.PAWSY_SERVER+"/get-csrf-token");

      const resp = await axios.post(process.env.PAWSY_SERVER+"/receive-message",
        { headers: { 'X-CSRF-TOKEN': token.data.csrfToken, 'Content-Type': 'application/json' } },
        { body: message.text.body, from: message.from, date: message.timestamp, channel: req.params.channelId }
      );
      console.log("---------- Has recibido un mensaje nuevo a las "+dateInGmtMinus6);
      console.log("De: "+message.from);
      console.log("Mensaje: "+message.text.body);*/
  }
  
}
catch(error){

}

  res.sendStatus(200);
});

app.get("/webhook/:channelId", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  const [channel, metadatos] = await sequelize.query('SELECT * FROM channel WHERE id = :id', {
    replacements: { id: req.params.channelId },
    type: sequelize.QueryTypes.SELECT
  });

  const data = JSON.parse(channel.omnichannel_w);

  if (mode === "subscribe" && token === data.webhook_token) {
    res.status(200).send(challenge);
    console.log("Webhook verified successfully!");
  } else {
    res.sendStatus(403);
  }
});

async function get_page_access(user, pageId, access_token) {
    const accounts = await axios.get(`https://graph.facebook.com/${user}/accounts?access_token=${access_token}`);

    let page = null;
    accounts.data.data.forEach(item => {
      if(item.id == pageId){
          page = item;
      }
    });

    return page;
};

async function getMessagesTranslation(item, access_token) {
    const urlMessageApi = `https://graph.facebook.com/v21.0/${item.id}?fields=id,created_time,from,to,message&access_token=${access_token}`;
    const response = await fetch(urlMessageApi);
    const data = await response.json();

    const fecha = new Date(data.created_time);
    const offsetCostaRica = 6 * 60;

    fecha.setMinutes(fecha.getMinutes() + offsetCostaRica - fecha.getTimezoneOffset());
    
    const anio = fecha.getFullYear();
    const mes = (fecha.getMonth() + 1).toString().padStart(2, '0');
    const dia = fecha.getDate().toString().padStart(2, '0');
    const horas = fecha.getHours().toString().padStart(2, '0');
    const minutos = fecha.getMinutes().toString().padStart(2, '0');
    const segundos = fecha.getSeconds().toString().padStart(2, '0');
    const offset = '-0600';
    
    data.created_time = `${anio}-${mes}-${dia}T${horas}:${minutos}:${segundos}${offset}`;

    return data;
  }

app.listen(process.env.PORT, () => {
    console.log(`Server is running on http://localhost:${process.env.PORT}`);
  });  