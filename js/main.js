// RJX Locações — shared behaviors
document.addEventListener('DOMContentLoaded', function () {
  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.style.display === 'flex';
      links.style.display = open ? 'none' : 'flex';
      links.style.flexDirection = 'column';
      links.style.position = 'absolute';
      links.style.top = '84px';
      links.style.left = '0';
      links.style.right = '0';
      links.style.background = '#fff';
      links.style.padding = '20px 28px';
      links.style.borderBottom = '1px solid #e7e3df';
    });
  }

  // Generic "send to WhatsApp" form handler.
  // Add data-wa-form to a <form> and data-wa-field="Label" to each input/select/textarea
  // you want included in the message. Optional data-wa-number on the form overrides
  // the default RJX WhatsApp number.
  var WA_NUMBER_DEFAULT = '5521976078440';

  document.querySelectorAll('form[data-wa-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var number = form.getAttribute('data-wa-number') || WA_NUMBER_DEFAULT;
      var introLine = form.getAttribute('data-wa-intro') || 'Olá! Vim pelo site da Rjx Locações.';
      var lines = [introLine, ''];

      form.querySelectorAll('[data-wa-field]').forEach(function (el) {
        var label = el.getAttribute('data-wa-field');
        var value = el.value ? el.value.trim() : '';
        if (value) lines.push(label + ': ' + value);
      });

      var text = encodeURIComponent(lines.join('\n'));
      var url = 'https://wa.me/' + number + '?text=' + text;
      window.open(url, '_blank');
    });
  });

  // Generic "send by e-mail" form handler.
  // Add data-mailto-form to a <form> and data-mailto-field="Label" to each input/select/textarea
  // to include. data-mailto-to sets the recipient, data-mailto-subject sets the subject line.
  document.querySelectorAll('form[data-mailto-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var to = form.getAttribute('data-mailto-to') || 'comercial.rjxlocacoes@gmail.com';
      var subject = form.getAttribute('data-mailto-subject') || 'Contato pelo site';
      var lines = [];

      form.querySelectorAll('[data-mailto-field]').forEach(function (el) {
        var label = el.getAttribute('data-mailto-field');
        var value = el.value ? el.value.trim() : '';
        if (value) lines.push(label + ': ' + value);
      });

      var body = encodeURIComponent(lines.join('\n'));
      var url = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + body;
      window.location.href = url;
    });
  });
});
