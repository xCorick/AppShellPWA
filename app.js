const lista = document.querySelector('#lista')

window.addEventListener('load', () =>{
    registerSW()
})

fetch("https://jsonplaceholder.typicode.com/users")
.then(response => response.json())
.then(data => {
    console.log(data)
    let html = ''
    data.forEach(user => {
        html += `<div class="card">
        <h2>${user.name}</h2>
        <div>${user.email}</div>
        </div>
        `
    });
    lista.innerHTML=html
})

async function registerSW() {
    if('serviceWorker' in navigator){
        try{
            await navigator.serviceWorker.register('./sw.js')
        }
        catch(e){
            console.log('fallo en el registro del service worker')
        }
    }
}