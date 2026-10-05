import os
folder = r'C:\Users\abc\Desktop\Vercelx'
old_tag = 'cWO6WZvMeG6vo7ki8tR7gopvGfHbsyuqaTG81vWUrtU'
new_tag = '59-lt8zZUYOM6qVl2YgOfNTazAAh8OQVYp5tF4VXz2w'
for f in os.listdir(folder):
    if f.endswith('.html'):
        path = os.path.join(folder, f)
        with open(path, 'r', encoding='utf-8') as file:
            content = file.read()
        if old_tag in content:
            new_content = content.replace(old_tag, new_tag)
            with open(path, 'w', encoding='utf-8') as file:
                file.write(new_content)
            print(f'Updated {f}')
